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
import { buildStubTargets } from '../test-utils/build-stub-targets';
import { getAgentEntry } from '../test-utils/get-agent-entry';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { buildTargetIdentity } from './build-target-identity';

/**
 * The fixed parts of a daemon whose targets come from a config.json on disk
 * through the real load: a config path in a temp directory of the test's
 * own, which the test writes or leaves absent before the boot, the claude
 * stand-in, whose headless runner records each turn it starts in `runs`, a
 * real codex adapter pointed at a binary that does not exist, so codex is
 * registered but not installed, and `harnesses`, which records the target
 * of each spawn.
 */
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-daemon-config-file-'));
  const configDir = join(tmp.dir, 'config');

  mkdirSync(configDir);

  const headless = buildStubHeadlessRunner();
  const claude = buildMockAgentAdapter({ headlessRunner: headless.runner });
  const codexConfig = parseConfig({ codexBin: join(tmp.dir, 'missing', 'codex') });

  const codex = new CodexAdapter(getAgentEntry(codexConfig, 'codex'));

  const harnesses: string[] = [];
  const owned = stack.move();

  return {
    configPath: join(configDir, 'config.json'),
    claude,
    adapters: [claude, codex],
    harnesses,
    runs: headless.runs,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it refuses a spawn without a target when an existing config holds invalid JSON', async () => {
  using ctx = setupTest();

  writeFileSync(ctx.configPath, '{ "targets": { "box": { "provider": "imp" } },');

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  const refused = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir });

  expect(refused).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(refused).rejects.toHaveProperty('data', {
    problem: 'config_malformed',
    path: ctx.configPath,
    detail: 'the file is not valid JSON',
  });

  expect({ harnesses: ctx.harnesses, runs: ctx.runs }).toStrictEqual({ harnesses: [], runs: [] });
});

test('it refuses a spawn on the local target when an existing config holds invalid JSON', async () => {
  using ctx = setupTest();

  writeFileSync(ctx.configPath, '{ "targets": { "box": { "provider": "imp" } },');

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  const refused = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, target: 'local' });

  expect(refused).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(refused).rejects.toHaveProperty('data', {
    problem: 'config_malformed',
    path: ctx.configPath,
    detail: 'the file is not valid JSON',
  });

  expect({ harnesses: ctx.harnesses, runs: ctx.runs }).toStrictEqual({ harnesses: [], runs: [] });
});

test('it refuses a spawn without a target when the config path is a directory', async () => {
  using ctx = setupTest();

  mkdirSync(ctx.configPath);

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  const refused = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir });

  expect(refused).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(refused).rejects.toHaveProperty('data', {
    problem: 'config_unreadable',
    path: ctx.configPath,
    detail: 'EISDIR',
  });

  expect({ harnesses: ctx.harnesses, runs: ctx.runs }).toStrictEqual({ harnesses: [], runs: [] });
});

test('it refuses a spawn on the local target when the config path is a directory', async () => {
  using ctx = setupTest();

  mkdirSync(ctx.configPath);

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  const refused = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, target: 'local' });

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
    using ctx = setupTest();

    writeFileSync(ctx.configPath, '{}');
    chmodSync(ctx.configPath, 0o000);

    await using daemon = await startTestDaemon({
      options: () => {
        const loaded = loadConfig(ctx.configPath);

        return {
          adapter: ctx.claude,
          adapters: ctx.adapters,
          ejectSettleMs: 0,
          targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
          defaultTarget: loaded.defaultTarget,
          targetErrors: loaded.targetErrors,
          principals: loaded.principals,
        };
      },
    });

    const refused = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir });

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
    using ctx = setupTest();

    writeFileSync(ctx.configPath, '{}');
    chmodSync(ctx.configPath, 0o000);

    await using daemon = await startTestDaemon({
      options: () => {
        const loaded = loadConfig(ctx.configPath);

        return {
          adapter: ctx.claude,
          adapters: ctx.adapters,
          ejectSettleMs: 0,
          targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
          defaultTarget: loaded.defaultTarget,
          targetErrors: loaded.targetErrors,
          principals: loaded.principals,
        };
      },
    });

    const refused = daemon.client.sendRequest('session.spawn', {
      cwd: daemon.dir,
      target: 'local',
    });

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
  using ctx = setupTest();

  writeFileSync(ctx.configPath, text);

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  const refused = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir });

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
  using ctx = setupTest();

  writeFileSync(ctx.configPath, text);

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  const refused = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, target: 'local' });

  expect(refused).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(refused).rejects.toHaveProperty('data', {
    problem: 'config_malformed',
    path: ctx.configPath,
    detail,
  });

  expect({ harnesses: ctx.harnesses, runs: ctx.runs }).toStrictEqual({ harnesses: [], runs: [] });
});

test('it refuses every spawn when a config file sets agents beside an old agent key', async () => {
  using ctx = setupTest();

  writeFileSync(ctx.configPath, JSON.stringify({ agents: { claude: {} }, claudeArgs: [] }));

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  const refused = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir });

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
  using ctx = setupTest();

  writeFileSync(ctx.configPath, '{ "claudeBin": ');

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      await using stack = new AsyncDisposableStack();

      const store = await StateStore.open(paths.dbPath);

      stack.defer(() => store.stop());

      await store.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-old'), name: 'old work', cwd: paths.dir }),
      ]);

      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const input = daemon.client.sendRequest('session.input', { session: 's-old', d: 'go\r' });

  expect(input).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(input).rejects.toHaveProperty('data', {
    problem: 'config_malformed',
    path: ctx.configPath,
    detail: 'the file is not valid JSON',
  });

  expect({ harnesses: ctx.harnesses, runs: ctx.runs }).toStrictEqual({ harnesses: [], runs: [] });
});

test('it lists the config problem, no targets, and no default target when the config holds invalid JSON', async () => {
  using ctx = setupTest();

  writeFileSync(ctx.configPath, '{ "targets": ');

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  const listed = await daemon.client.sendRequest('agents.list');

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
  using ctx = setupTest();

  writeFileSync(ctx.configPath, '{ "targets": ');

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  expect(daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it spawns a session without a target on the local target when no config exists', async () => {
  using ctx = setupTest();

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  const spawned = await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir });

  expect({
    targetID: getRecord(getRecord(spawned, 'session'), 'locator')['targetID'],
    harnesses: ctx.harnesses,
  }).toStrictEqual({ targetID: 'local', harnesses: ['local'] });
});

test('it writes the default config when no config exists', async () => {
  using ctx = setupTest();

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  await daemon.client.sendRequest('session.spawn', { cwd: daemon.dir });

  expect(JSON.parse(readFileSync(ctx.configPath, 'utf8'))).toMatchObject({
    agents: { claude: {} },
  });
});

test('it refuses a spawn of an agent missing from this host with the config problem when the config holds invalid JSON', async () => {
  using ctx = setupTest();

  writeFileSync(ctx.configPath, '{ "targets": ');

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, agent: 'codex' });

  expect(spawn).rejects.toHaveProperty('code', 'target_config_invalid');

  expect(spawn).rejects.toHaveProperty('data', {
    problem: 'config_malformed',
    path: ctx.configPath,
    detail: 'the file is not valid JSON',
  });

  expect(ctx.harnesses).toStrictEqual([]);
});

test('it refuses a spawn of an agent missing from this host as not installed when the config is usable', async () => {
  using ctx = setupTest();

  writeFileSync(ctx.configPath, '{}');

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  const spawn = daemon.client.sendRequest('session.spawn', { cwd: daemon.dir, agent: 'codex' });

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
  using ctx = setupTest();

  writeFileSync(ctx.configPath, text);

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  const refusal = daemon.client.sendRequest('session.spawn', { ...params, cwd: daemon.dir });

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
  using ctx = setupTest();

  writeFileSync(ctx.configPath, text);

  await using daemon = await startTestDaemon({
    options: () => {
      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  const listed = await daemon.client.sendRequest('agents.list');

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
    using ctx = setupTest();

    writeFileSync(ctx.configPath, text);

    await using daemon = await startTestDaemon({
      options: async (paths) => {
        await using stack = new AsyncDisposableStack();

        const store = await StateStore.open(paths.dbPath);

        stack.defer(() => store.stop());

        await store.writeFleet([
          buildMockFleetEntry({
            sessionID: toSessionID('s-old'),
            name: 'old work',
            cwd: paths.dir,
            target,
            targetIdentity: buildTargetIdentity('local-pty', {}),
          }),
        ]);

        const loaded = loadConfig(ctx.configPath);

        return {
          adapter: ctx.claude,
          adapters: ctx.adapters,
          ejectSettleMs: 0,
          targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
          defaultTarget: loaded.defaultTarget,
          targetErrors: loaded.targetErrors,
          principals: loaded.principals,
        };
      },
    });

    await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    const sessions = await daemon.client.sendRequest('session.list');

    expect(JSON.stringify(sessions)).not.toInclude('sk_fixture_NOT_A_SECRET_1234');
  },
);

test('it gives a principal legacy rights over a restored local session when no config exists', async () => {
  using ctx = setupTest();

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      await using stack = new AsyncDisposableStack();

      const store = await StateStore.open(paths.dbPath);

      stack.defer(() => store.stop());

      await store.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-old'), name: 'old work', cwd: paths.dir }),
      ]);

      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 1, rows: 1 });

  const listed = await daemon.client.sendRequest('session.list', {}, 'client-a');

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
    using ctx = setupTest();

    writeFileSync(ctx.configPath, text);

    await using daemon = await startTestDaemon({
      options: async (paths) => {
        await using stack = new AsyncDisposableStack();

        const store = await StateStore.open(paths.dbPath);

        stack.defer(() => store.stop());

        await store.writeFleet([
          buildMockFleetEntry({
            sessionID: toSessionID('s-old'),
            name: 'old work',
            cwd: paths.dir,
          }),
        ]);

        const loaded = loadConfig(ctx.configPath);

        return {
          adapter: ctx.claude,
          adapters: ctx.adapters,
          ejectSettleMs: 0,
          targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
          defaultTarget: loaded.defaultTarget,
          targetErrors: loaded.targetErrors,
          principals: loaded.principals,
        };
      },
    });

    await daemon.client.sendRequest('fleet.restore', { cols: 1, rows: 1 });

    const listed = await daemon.client.sendRequest('session.list', {}, 'client-a');

    expect(listed).toStrictEqual({ sessions: [] });
  },
);

test('it hides a restored local session from a principal when the config path is a directory', async () => {
  using ctx = setupTest();

  mkdirSync(ctx.configPath);

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      await using stack = new AsyncDisposableStack();

      const store = await StateStore.open(paths.dbPath);

      stack.defer(() => store.stop());

      await store.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-old'), name: 'old work', cwd: paths.dir }),
      ]);

      const loaded = loadConfig(ctx.configPath);

      return {
        adapter: ctx.claude,
        adapters: ctx.adapters,
        ejectSettleMs: 0,
        targets: buildStubTargets(loaded.targets, { spawned: ctx.harnesses }),
        defaultTarget: loaded.defaultTarget,
        targetErrors: loaded.targetErrors,
        principals: loaded.principals,
      };
    },
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 1, rows: 1 });

  const listed = await daemon.client.sendRequest('session.list', {}, 'client-a');

  expect(listed).toStrictEqual({ sessions: [] });
});
