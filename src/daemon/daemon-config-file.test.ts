import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter } from '../agents/codex-adapter';
import { DaemonError } from '../protocol/daemon-error';
import { loadConfig, parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { buildStubHeadlessRunner } from '../test-utils/build-stub-headless-runner';
import { buildStubPTYProvider } from '../test-utils/build-stub-pty-provider';
import { getAgentEntry } from '../test-utils/get-agent-entry';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { buildTargetIdentity } from './build-target-identity';

/**
 * What the test leaves on disk before the daemon boots: the config file's
 * path, which the test may write or leave absent, the test's temp
 * directory, and an open state store, closed before the boot.
 */
interface BeforeBoot {
  readonly configPath: string;
  readonly dir: string;
  readonly store: StateStore;
}

interface SetupConfig {
  readonly beforeBoot: (disk: BeforeBoot) => Promise<void> | void;
}

/**
 * A real daemon whose targets come from a config.json on disk through the
 * real load, at a path the test arranges before the boot. Every
 * `local-pty` target runs harnesses on a real pseudo-terminal through a
 * provider that records the target of each spawn in `harnesses`, and the
 * claude stand-in's headless runner records each turn it starts in `runs`.
 * The real codex adapter points at a binary that does not exist, so codex
 * is registered but not installed.
 */
async function setupTest(config: SetupConfig) {
  const headless = buildStubHeadlessRunner();
  const harnesses: string[] = [];

  const harness = await startTestDaemon({
    prefix: 'atc-daemon-config-file-',
    options: async (paths) => {
      const configPath = join(paths.dir, 'config', 'config.json');

      mkdirSync(join(paths.dir, 'config'), { recursive: true });

      await using stack = new AsyncDisposableStack();

      const store = await StateStore.open(paths.dbPath);

      stack.defer(() => store.stop());

      await config.beforeBoot({ configPath, dir: paths.dir, store });
      await stack.disposeAsync();

      const loaded = loadConfig(configPath);
      const claude = buildMockAgentAdapter({ headlessRunner: headless.runner });
      const codexConfig = parseConfig({ codexBin: join(paths.dir, 'missing', 'codex') });

      const codex = new CodexAdapter(getAgentEntry(codexConfig, 'codex'));

      return {
        adapter: claude,
        adapters: [claude, codex],
        ejectSettleMs: 0,
        targets: loaded.targets.map((target) => ({
          id: target.id,
          kind: target.provider,
          options: target.options,
          identity: buildTargetIdentity(target.provider, target.options),
          provider:
            new Map([
              [
                'local-pty',
                buildStubPTYProvider({
                  onSpawn: () => {
                    harnesses.push(target.id);
                  },
                }),
              ],
            ]).get(target.provider) ?? null,
        })),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  return Object.assign(harness, {
    configPath: join(harness.dir, 'config', 'config.json'),
    harnesses,
    runs: headless.runs,
  });
}

test('it refuses a spawn without a target when an existing config holds invalid JSON', async () => {
  await using ctx = await setupTest({
    beforeBoot: (disk) => {
      writeFileSync(disk.configPath, '{ "targets": { "box": { "provider": "imp" } },');
    },
  });

  const refused = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir });

  expect(refused).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(refused).rejects.toHaveProperty('data', {
    problem: 'config_malformed',
    path: ctx.configPath,
    detail: 'the file is not valid JSON',
  });

  expect({ harnesses: ctx.harnesses, runs: ctx.runs }).toStrictEqual({ harnesses: [], runs: [] });
});

test('it refuses a spawn on the local target when an existing config holds invalid JSON', async () => {
  await using ctx = await setupTest({
    beforeBoot: (disk) => {
      writeFileSync(disk.configPath, '{ "targets": { "box": { "provider": "imp" } },');
    },
  });

  const refused = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, target: 'local' });

  expect(refused).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(refused).rejects.toHaveProperty('data', {
    problem: 'config_malformed',
    path: ctx.configPath,
    detail: 'the file is not valid JSON',
  });

  expect({ harnesses: ctx.harnesses, runs: ctx.runs }).toStrictEqual({ harnesses: [], runs: [] });
});

test('it refuses a spawn without a target when the config path is a directory', async () => {
  await using ctx = await setupTest({
    beforeBoot: (disk) => {
      mkdirSync(disk.configPath);
    },
  });

  const refused = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir });

  expect(refused).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(refused).rejects.toHaveProperty('data', {
    problem: 'config_unreadable',
    path: ctx.configPath,
    detail: 'EISDIR',
  });

  expect({ harnesses: ctx.harnesses, runs: ctx.runs }).toStrictEqual({ harnesses: [], runs: [] });
});

test('it refuses a spawn on the local target when the config path is a directory', async () => {
  await using ctx = await setupTest({
    beforeBoot: (disk) => {
      mkdirSync(disk.configPath);
    },
  });

  const refused = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, target: 'local' });

  expect(refused).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(refused).rejects.toHaveProperty('data', {
    problem: 'config_unreadable',
    path: ctx.configPath,
    detail: 'EISDIR',
  });

  expect({ harnesses: ctx.harnesses, runs: ctx.runs }).toStrictEqual({ harnesses: [], runs: [] });
});

// Root reads a mode-000 file, so the permission check this exercises never
// runs for it.
test.skipIf(process.getuid?.() === 0)(
  'it refuses a spawn without a target when the config file cannot be read',
  async () => {
    await using ctx = await setupTest({
      beforeBoot: (disk) => {
        writeFileSync(disk.configPath, '{}');
        chmodSync(disk.configPath, 0o000);
      },
    });

    const refused = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir });

    expect(refused).rejects.toHaveProperty('code', 'target_config_invalid');

    expect(refused).rejects.toHaveProperty('data', {
      problem: 'config_unreadable',
      path: ctx.configPath,
      detail: 'EACCES',
    });

    expect({ harnesses: ctx.harnesses, runs: ctx.runs }).toStrictEqual({ harnesses: [], runs: [] });
  },
);

// Root reads a mode-000 file, so the permission check this exercises never
// runs for it.
test.skipIf(process.getuid?.() === 0)(
  'it refuses a spawn on the local target when the config file cannot be read',
  async () => {
    await using ctx = await setupTest({
      beforeBoot: (disk) => {
        writeFileSync(disk.configPath, '{}');
        chmodSync(disk.configPath, 0o000);
      },
    });

    const refused = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, target: 'local' });

    expect(refused).rejects.toHaveProperty('code', 'target_config_invalid');

    expect(refused).rejects.toHaveProperty('data', {
      problem: 'config_unreadable',
      path: ctx.configPath,
      detail: 'EACCES',
    });

    expect({ harnesses: ctx.harnesses, runs: ctx.runs }).toStrictEqual({ harnesses: [], runs: [] });
  },
);

test.each([
  ['[]', 'the root is an array, not an object'],
  ['3', 'the root is a number, not an object'],
  ['"local"', 'the root is a string, not an object'],
  ['null', 'the root is null, not an object'],
])('it refuses a spawn without a target when the config root is %s', async (text, detail) => {
  await using ctx = await setupTest({
    beforeBoot: (disk) => {
      writeFileSync(disk.configPath, text);
    },
  });

  const refused = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir });

  expect(refused).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(refused).rejects.toHaveProperty('data', {
    problem: 'config_malformed',
    path: ctx.configPath,
    detail,
  });

  expect({ harnesses: ctx.harnesses, runs: ctx.runs }).toStrictEqual({ harnesses: [], runs: [] });
});

test.each([
  ['[]', 'the root is an array, not an object'],
  ['3', 'the root is a number, not an object'],
  ['"local"', 'the root is a string, not an object'],
  ['null', 'the root is null, not an object'],
])('it refuses a spawn on the local target when the config root is %s', async (text, detail) => {
  await using ctx = await setupTest({
    beforeBoot: (disk) => {
      writeFileSync(disk.configPath, text);
    },
  });

  const refused = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, target: 'local' });

  expect(refused).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(refused).rejects.toHaveProperty('data', {
    problem: 'config_malformed',
    path: ctx.configPath,
    detail,
  });

  expect({ harnesses: ctx.harnesses, runs: ctx.runs }).toStrictEqual({ harnesses: [], runs: [] });
});

test('it refuses every spawn when a config file sets agents beside an old agent key', async () => {
  await using ctx = await setupTest({
    beforeBoot: (disk) => {
      writeFileSync(disk.configPath, JSON.stringify({ agents: { claude: {} }, claudeArgs: [] }));
    },
  });

  const refused = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir });

  expect(refused).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(refused).rejects.toHaveProperty('data', {
    problem: 'config_malformed',
    path: ctx.configPath,
    detail:
      "claudeArgs cannot be set together with agents; move them into agents or run 'atc config migrate'",
  });

  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses input to a restored local session without running a turn when the config holds invalid JSON', async () => {
  await using ctx = await setupTest({
    beforeBoot: async (disk) => {
      await disk.store.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-old'), name: 'old work', cwd: disk.dir }),
      ]);

      writeFileSync(disk.configPath, '{ "claudeBin": ');
    },
  });

  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const input = ctx.client.sendRequest('session.input', { session: 's-old', d: 'go\r' });

  expect(input).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(input).rejects.toHaveProperty('data', {
    problem: 'config_malformed',
    path: ctx.configPath,
    detail: 'the file is not valid JSON',
  });

  expect({ harnesses: ctx.harnesses, runs: ctx.runs }).toStrictEqual({ harnesses: [], runs: [] });
});

test('it lists the config problem, no targets, and no default target when the config holds invalid JSON', async () => {
  await using ctx = await setupTest({
    beforeBoot: (disk) => {
      writeFileSync(disk.configPath, '{ "targets": ');
    },
  });

  const listed = await ctx.client.sendRequest('agents.list');

  expect({
    targets: listed['targets'],
    spawnDefaults: listed['spawnDefaults'],
    targetErrors: listed['targetErrors'],
  }).toStrictEqual({
    targets: [],
    spawnDefaults: { agent: 'claude', target: null },
    targetErrors: [
      {
        scope: 'config',
        problem: 'config_malformed',
        path: ctx.configPath,
        detail: 'the file is not valid JSON',
      },
    ],
  });
});

test('it lists no sessions and keeps answering when the config holds invalid JSON', async () => {
  await using ctx = await setupTest({
    beforeBoot: (disk) => {
      writeFileSync(disk.configPath, '{ "targets": ');
    },
  });

  expect(ctx.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it spawns a session without a target on the local target when no config exists', async () => {
  await using ctx = await setupTest({ beforeBoot: () => {} });

  const spawned = await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir });

  expect({
    targetID: getRecord(getRecord(spawned, 'session'), 'locator')['targetID'],
    harnesses: ctx.harnesses,
  }).toStrictEqual({ targetID: 'local', harnesses: ['local'] });
});

test('it writes the default config when no config exists', async () => {
  await using ctx = await setupTest({ beforeBoot: () => {} });

  await ctx.client.sendRequest('session.spawn', { cwd: ctx.dir });

  expect(JSON.parse(readFileSync(ctx.configPath, 'utf8'))).toMatchObject({
    agents: { claude: {} },
  });
});

test('it refuses a spawn of an agent missing from this host with the config problem when the config holds invalid JSON', async () => {
  await using ctx = await setupTest({
    beforeBoot: (disk) => {
      writeFileSync(disk.configPath, '{ "targets": ');
    },
  });

  const spawn = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, agent: 'codex' });

  expect(spawn).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(spawn).rejects.toHaveProperty('data', {
    problem: 'config_malformed',
    path: ctx.configPath,
    detail: 'the file is not valid JSON',
  });

  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses a spawn of an agent missing from this host as not installed when the config is usable', async () => {
  await using ctx = await setupTest({
    beforeBoot: (disk) => {
      writeFileSync(disk.configPath, '{}');
    },
  });

  const spawn = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, agent: 'codex' });

  expect(spawn).rejects.toMatchObject({
    code: 'unsupported',
    message: "agent 'codex' is registered but not installed on this host",
  });

  expect(ctx.harnesses).toStrictEqual([]);
});

test.each([
  [
    '{ "targets": { "local": { "provider": "local-pty" } }, "token": sk_fixture_NOT_A_SECRET_1234 }',
    {},
  ],
  [
    '{ "targets": { "local": { "provider": "local-pty" } }, "defaultTarget": { "token": "sk_fixture_NOT_A_SECRET_1234" } }',
    {},
  ],
  [
    '{ "targets": { "local": { "provider": "local-pty" }, "box": { "provider": 7, "token": "sk_fixture_NOT_A_SECRET_1234" } } }',
    { target: 'box' },
  ],
])('it keeps a config value out of the spawn refusal for the config %s', async (text, params) => {
  await using ctx = await setupTest({
    beforeBoot: (disk) => {
      writeFileSync(disk.configPath, text);
    },
  });

  const refusal = ctx.client.sendRequest('session.spawn', { ...params, cwd: ctx.dir });

  expect(refusal).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(refusal).rejects.toSatisfy(
    (refused: unknown) =>
      refused instanceof DaemonError &&
      !JSON.stringify({ message: refused.message, data: refused.data }).includes(
        'sk_fixture_NOT_A_SECRET_1234',
      ),
  );
});

test.each([
  '{ "targets": { "local": { "provider": "local-pty" } }, "token": sk_fixture_NOT_A_SECRET_1234 }',
  '{ "targets": { "local": { "provider": "local-pty" } }, "defaultTarget": { "token": "sk_fixture_NOT_A_SECRET_1234" } }',
  '{ "targets": { "local": { "provider": "local-pty" }, "box": { "provider": 7, "token": "sk_fixture_NOT_A_SECRET_1234" } } }',
])('it keeps a config value out of the listed target errors for the config %s', async (text) => {
  await using ctx = await setupTest({
    beforeBoot: (disk) => {
      writeFileSync(disk.configPath, text);
    },
  });

  const listed = await ctx.client.sendRequest('agents.list');

  expect(JSON.stringify(listed['targetErrors'])).not.toInclude('sk_fixture_NOT_A_SECRET_1234');
});

test.each([
  [
    '{ "targets": { "local": { "provider": "local-pty" } }, "token": sk_fixture_NOT_A_SECRET_1234 }',
    'local',
  ],
  [
    '{ "targets": { "local": { "provider": "local-pty" } }, "defaultTarget": { "token": "sk_fixture_NOT_A_SECRET_1234" } }',
    'local',
  ],
  [
    '{ "targets": { "local": { "provider": "local-pty" }, "box": { "provider": 7, "token": "sk_fixture_NOT_A_SECRET_1234" } } }',
    'box',
  ],
])(
  'it keeps a config value out of the session rows of a restored fleet for the config %s',
  async (text, target) => {
    await using ctx = await setupTest({
      beforeBoot: async (disk) => {
        await disk.store.writeFleet([
          buildMockFleetEntry({
            sessionID: toSessionID('s-old'),
            name: 'old work',
            cwd: disk.dir,
            target,
            targetIdentity: buildTargetIdentity('local-pty', {}),
          }),
        ]);

        writeFileSync(disk.configPath, text);
      },
    });

    await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    const sessions = await ctx.client.sendRequest('session.list');

    expect(JSON.stringify(sessions)).not.toInclude('sk_fixture_NOT_A_SECRET_1234');
  },
);

test('it gives a principal legacy rights over a restored local session when no config exists', async () => {
  await using ctx = await setupTest({
    beforeBoot: async (disk) => {
      await disk.store.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-old'), name: 'old work', cwd: disk.dir }),
      ]);
    },
  });

  await ctx.client.sendRequest('fleet.restore', { cols: 1, rows: 1 });

  const listed = await ctx.client.sendRequest('session.list', {}, 'client-a');

  expect(listed).toMatchObject({ sessions: [{ id: 's-old' }] });
});

test.each([
  ['invalid JSON', '{ "claudeBin": '],
  ['an array', '[]'],
  ['a number', '42'],
  ['null', 'null'],
  ['a principals section that is not an object', '{ "principals": "all" }'],
])(
  'it hides a restored local session from a principal when the config holds %s',
  async (_holding, text) => {
    await using ctx = await setupTest({
      beforeBoot: async (disk) => {
        await disk.store.writeFleet([
          buildMockFleetEntry({ sessionID: toSessionID('s-old'), name: 'old work', cwd: disk.dir }),
        ]);

        writeFileSync(disk.configPath, text);
      },
    });

    await ctx.client.sendRequest('fleet.restore', { cols: 1, rows: 1 });

    const listed = await ctx.client.sendRequest('session.list', {}, 'client-a');

    expect(listed).toStrictEqual({ sessions: [] });
  },
);

test('it hides a restored local session from a principal when the config path is a directory', async () => {
  await using ctx = await setupTest({
    beforeBoot: async (disk) => {
      await disk.store.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-old'), name: 'old work', cwd: disk.dir }),
      ]);

      mkdirSync(disk.configPath);
    },
  });

  await ctx.client.sendRequest('fleet.restore', { cols: 1, rows: 1 });

  const listed = await ctx.client.sendRequest('session.list', {}, 'client-a');

  expect(listed).toStrictEqual({ sessions: [] });
});
