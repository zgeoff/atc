import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { CodexAdapter } from '../agents/codex-adapter';
import { DaemonClient } from '../client/daemon-client';
import { DaemonError } from '../protocol/daemon-error';
import { loadConfig, parseConfig } from '../shared/config';
import { getRecord } from '../shared/get-record';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { getAgentEntry } from '../test-utils/get-agent-entry';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { buildTargetIdentity } from './build-target-identity';
import { startDaemon } from './daemon';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * A real daemon whose targets come from a config.json on disk through the
 * real load, at a path the test arranges before it opens the daemon. Every
 * `local-pty` target runs harnesses on a real pseudo-terminal through a
 * provider that records each spawn, and the claude stand-in's headless
 * runner records each turn it starts. The real codex adapter points at a
 * binary that does not exist, so codex is registered but not installed.
 */
function setupTest() {
  const tmp = setupTempDir('atc-daemon-config-file-');
  const dbPath = join(tmp.dir, 'state.db');
  const configPath = join(tmp.dir, 'config', 'config.json');

  const local = new LocalPTYProvider();

  const harnesses: string[] = [];
  const runs: string[] = [];
  let stopCurrent: (() => Promise<void>) | null = null;

  mkdirSync(join(tmp.dir, 'config'));

  const openDaemon = async () => {
    const config = loadConfig(configPath);

    const claude: AgentAdapter = {
      id: 'claude',
      screenDetector: null,
      takesMessages: false,
      headlessRunner: (opts, hooks) => {
        runs.push(opts.prompt);

        setTimeout(() => {
          hooks.onDone('turn finished');
        }, 0);

        return { stop: () => {} };
      },
      planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
      normalizeHook: () => ({ kind: 'heartbeat' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => null,
    };

    const adapterConfig = parseConfig({ codexBin: join(tmp.dir, 'missing', 'codex') });

    const codex = new CodexAdapter(getAgentEntry(adapterConfig, 'codex'));

    const daemon = await startDaemon({
      socketPath: join(tmp.dir, 'daemon.sock'),
      reporterSocketPath: join(tmp.dir, 'reporter.sock'),
      build: 'atc/test-build',
      adapter: claude,
      adapters: [claude, codex],
      dbPath,
      statusPath: join(tmp.dir, 'status.json'),
      ejectSettleMs: 0,
      targets: config.targets.map((target) => ({
        id: target.id,
        kind: target.provider,
        options: target.options,
        identity: buildTargetIdentity(target.provider, target.options),
        provider:
          target.provider === 'local-pty'
            ? {
                kind: target.provider,
                remote: false,
                prepareHost: local.prepareHost,
                dispose: local.dispose,
                capabilities: local.capabilities,
                spawnHarness: (spec) => {
                  harnesses.push(target.id);

                  return local.spawnHarness(spec);
                },
                transferArchive: local.transferArchive,
                runCommand: local.runCommand,
                suspendHost: local.suspendHost,
                destroyHost: local.destroyHost,
              }
            : null,
      })),
      defaultTarget: config.defaultTarget,
      targetErrors: config.targetErrors,
      principals: config.principals,
    });

    const client = await DaemonClient.open(join(tmp.dir, 'daemon.sock'));

    await client.sendHello('atc/test-build');

    stopCurrent = async () => {
      client.stop();

      await daemon.stop();
    };

    return client;
  };

  return {
    dbPath,
    configPath,
    harnesses,
    runs,
    openDaemon,
    async [Symbol.asyncDispose]() {
      await stopCurrent?.();

      tmp[Symbol.dispose]();
    },
  };
}

test('it refuses every spawn, local included, when an existing config holds invalid JSON', async () => {
  await using daemon = setupTest();

  writeFileSync(daemon.configPath, '{ "targets": { "box": { "provider": "imp" } },');

  const client = await daemon.openDaemon();

  const bare = await client
    .sendRequest('session.spawn', { cwd: '/tmp' })
    .catch((error: unknown) => error);

  const local = await client
    .sendRequest('session.spawn', { cwd: '/tmp', target: 'local' })
    .catch((error: unknown) => error);

  if (!(bare instanceof DaemonError) || !(local instanceof DaemonError)) {
    throw new Error('expected both spawns to reject with a daemon error');
  }

  expect([
    { code: bare.code, data: bare.data },
    { code: local.code, data: local.data },
  ]).toStrictEqual([
    {
      code: 'target_config_invalid',
      data: {
        problem: 'config_malformed',
        path: daemon.configPath,
        detail: 'the file is not valid JSON',
      },
    },
    {
      code: 'target_config_invalid',
      data: {
        problem: 'config_malformed',
        path: daemon.configPath,
        detail: 'the file is not valid JSON',
      },
    },
  ]);

  expect(daemon.harnesses).toStrictEqual([]);
  expect(daemon.runs).toStrictEqual([]);
});

test('it refuses every spawn when a config file sets agents beside an old agent key', async () => {
  await using daemon = setupTest();

  writeFileSync(daemon.configPath, JSON.stringify({ agents: { claude: {} }, claudeArgs: [] }));

  const client = await daemon.openDaemon();

  const refused = await client
    .sendRequest('session.spawn', { cwd: '/tmp' })
    .catch((error: unknown) => error);

  if (!(refused instanceof DaemonError)) {
    throw new Error('expected the spawn to reject with a daemon error');
  }

  expect({ code: refused.code, data: refused.data }).toStrictEqual({
    code: 'target_config_invalid',
    data: {
      problem: 'config_malformed',
      path: daemon.configPath,
      detail:
        "claudeArgs cannot be set together with agents; move them into agents or run 'atc config migrate'",
    },
  });

  expect(daemon.harnesses).toStrictEqual([]);
});

test.each([
  ['[]', 'the root is an array, not an object'],
  ['3', 'the root is a number, not an object'],
  ['"local"', 'the root is a string, not an object'],
  ['null', 'the root is null, not an object'],
])('it refuses every spawn, local included, when the config root is %s', async (text, detail) => {
  await using daemon = setupTest();

  writeFileSync(daemon.configPath, text);

  const client = await daemon.openDaemon();

  const bare = await client
    .sendRequest('session.spawn', { cwd: '/tmp' })
    .catch((error: unknown) => error);

  const local = await client
    .sendRequest('session.spawn', { cwd: '/tmp', target: 'local' })
    .catch((error: unknown) => error);

  if (!(bare instanceof DaemonError) || !(local instanceof DaemonError)) {
    throw new Error('expected both spawns to reject with a daemon error');
  }

  expect([
    { code: bare.code, data: bare.data },
    { code: local.code, data: local.data },
  ]).toStrictEqual([
    {
      code: 'target_config_invalid',
      data: { problem: 'config_malformed', path: daemon.configPath, detail },
    },
    {
      code: 'target_config_invalid',
      data: { problem: 'config_malformed', path: daemon.configPath, detail },
    },
  ]);

  expect(daemon.harnesses).toStrictEqual([]);
  expect(daemon.runs).toStrictEqual([]);
});

test('it refuses every spawn, local included, when the config path is a directory', async () => {
  await using daemon = setupTest();

  mkdirSync(daemon.configPath);

  const client = await daemon.openDaemon();

  const bare = await client
    .sendRequest('session.spawn', { cwd: '/tmp' })
    .catch((error: unknown) => error);

  const local = await client
    .sendRequest('session.spawn', { cwd: '/tmp', target: 'local' })
    .catch((error: unknown) => error);

  if (!(bare instanceof DaemonError) || !(local instanceof DaemonError)) {
    throw new Error('expected both spawns to reject with a daemon error');
  }

  expect([
    { code: bare.code, data: bare.data },
    { code: local.code, data: local.data },
  ]).toStrictEqual([
    {
      code: 'target_config_invalid',
      data: { problem: 'config_unreadable', path: daemon.configPath, detail: 'EISDIR' },
    },
    {
      code: 'target_config_invalid',
      data: { problem: 'config_unreadable', path: daemon.configPath, detail: 'EISDIR' },
    },
  ]);

  expect(daemon.harnesses).toStrictEqual([]);
  expect(daemon.runs).toStrictEqual([]);
});

// Root reads a mode-000 file, so the permission check this exercises never
// runs for it.
test.skipIf(process.getuid?.() === 0)(
  'it refuses every spawn, local included, when the config file cannot be read',
  async () => {
    await using daemon = setupTest();

    writeFileSync(daemon.configPath, '{}');
    chmodSync(daemon.configPath, 0o000);

    const client = await daemon.openDaemon();

    const bare = await client
      .sendRequest('session.spawn', { cwd: '/tmp' })
      .catch((error: unknown) => error);

    const local = await client
      .sendRequest('session.spawn', { cwd: '/tmp', target: 'local' })
      .catch((error: unknown) => error);

    if (!(bare instanceof DaemonError) || !(local instanceof DaemonError)) {
      throw new Error('expected both spawns to reject with a daemon error');
    }

    expect([
      { code: bare.code, data: bare.data },
      { code: local.code, data: local.data },
    ]).toStrictEqual([
      {
        code: 'target_config_invalid',
        data: { problem: 'config_unreadable', path: daemon.configPath, detail: 'EACCES' },
      },
      {
        code: 'target_config_invalid',
        data: { problem: 'config_unreadable', path: daemon.configPath, detail: 'EACCES' },
      },
    ]);

    expect(daemon.harnesses).toStrictEqual([]);
    expect(daemon.runs).toStrictEqual([]);
  },
);

test('it refuses input to a restored local session without running a turn when the config holds invalid JSON', async () => {
  await using daemon = setupTest();

  const store = await StateStore.open(daemon.dbPath);

  await store.writeFleet([
    {
      sessionID: toSessionID('s-old'),
      name: 'old work',
      cwd: '/tmp',
      agentSessionID: toAgentSessionID('a-old'),
      agent: 'claude',
    },
  ]);

  await store.stop();

  writeFileSync(daemon.configPath, '{ "claudeBin": ');

  const client = await daemon.openDaemon();

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const input = client.sendRequest('session.input', { session: 's-old', d: 'go\r' });

  expect(input).rejects.toMatchObject({
    code: 'target_config_invalid',
    data: { problem: 'config_malformed', path: daemon.configPath },
  });

  expect(daemon.runs).toStrictEqual([]);
  expect(daemon.harnesses).toStrictEqual([]);
});

test('it lists the config problem, no targets, and no default target when the config holds invalid JSON', async () => {
  await using daemon = setupTest();

  writeFileSync(daemon.configPath, '{ "targets": ');

  const client = await daemon.openDaemon();
  const listed = await client.sendRequest('agents.list');

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
        path: daemon.configPath,
        detail: 'the file is not valid JSON',
      },
    ],
  });

  expect(client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it spawns a session without a target on the local target, and writes the defaults, when no config exists', async () => {
  await using daemon = setupTest();

  const client = await daemon.openDaemon();
  const spawned = await client.sendRequest('session.spawn', { cwd: '/tmp' });

  expect(getRecord(spawned, 'session')['locator']).toMatchObject({ targetID: 'local' });
  expect(daemon.harnesses).toStrictEqual(['local']);

  expect(JSON.parse(readFileSync(daemon.configPath, 'utf8'))).toMatchObject({
    agents: { claude: {} },
  });
});

test('it refuses a spawn of an agent missing from this host with the config problem when the config holds invalid JSON', async () => {
  await using daemon = setupTest();

  writeFileSync(daemon.configPath, '{ "targets": ');

  const client = await daemon.openDaemon();

  const spawn = client.sendRequest('session.spawn', { cwd: '/tmp', agent: 'codex' });

  expect(spawn).rejects.toMatchObject({
    code: 'target_config_invalid',
    data: { problem: 'config_malformed', path: daemon.configPath },
  });

  expect(daemon.harnesses).toStrictEqual([]);
});

test('it refuses a spawn of an agent missing from this host as not installed when the config is usable', async () => {
  await using daemon = setupTest();

  writeFileSync(daemon.configPath, '{}');

  const client = await daemon.openDaemon();

  const spawn = client.sendRequest('session.spawn', { cwd: '/tmp', agent: 'codex' });

  expect(spawn).rejects.toMatchObject({
    code: 'unsupported',
    message: "agent 'codex' is registered but not installed on this host",
  });

  expect(daemon.harnesses).toStrictEqual([]);
});

test.each([
  [
    'JSON with a syntax error at the value',
    '{ "targets": { "local": { "provider": "local-pty" } }, "token": sk_fixture_NOT_A_SECRET_1234 }',
    'local',
    { cwd: '/tmp' },
  ],
  [
    'a defaultTarget object holding the value',
    '{ "targets": { "local": { "provider": "local-pty" } }, "defaultTarget": { "token": "sk_fixture_NOT_A_SECRET_1234" } }',
    'local',
    { cwd: '/tmp' },
  ],
  [
    'a malformed target entry holding the value',
    '{ "targets": { "local": { "provider": "local-pty" }, "box": { "provider": 7, "token": "sk_fixture_NOT_A_SECRET_1234" } } }',
    'box',
    { cwd: '/tmp', target: 'box' },
  ],
])(
  'it keeps a config value out of every refusal, listing, and session row for %s',
  async (_label, text, fleetTarget, spawnParams) => {
    await using daemon = setupTest();

    const store = await StateStore.open(daemon.dbPath);

    await store.writeFleet([
      {
        sessionID: toSessionID('s-old'),
        name: 'old work',
        cwd: '/tmp',
        agentSessionID: toAgentSessionID('a-old'),
        agent: 'claude',
        target: fleetTarget,
        targetIdentity: buildTargetIdentity('local-pty', {}),
      },
    ]);

    await store.stop();

    writeFileSync(daemon.configPath, text);

    const client = await daemon.openDaemon();

    const refusal = await client
      .sendRequest('session.spawn', spawnParams)
      .catch((error: unknown) => error);

    if (!(refusal instanceof DaemonError)) {
      throw new Error('expected the spawn to reject with a daemon error');
    }

    const listed = await client.sendRequest('agents.list');

    await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

    const sessions = await client.sendRequest('session.list');

    expect(refusal.code).toBe('target_config_invalid');

    expect(
      JSON.stringify([
        { code: refusal.code, message: refusal.message, data: refusal.data },
        listed['targetErrors'],
        sessions,
      ]),
    ).not.toInclude('sk_fixture_NOT_A_SECRET_1234');
  },
);

test.each([
  ['holds invalid JSON', 'file', '{ "claudeBin": ', false],
  ['holds an array', 'file', '[]', false],
  ['holds a number', 'file', '42', false],
  ['holds null', 'file', 'null', false],
  ['is a directory', 'directory', '', false],
  ['holds a principals section that is not an object', 'file', '{ "principals": "all" }', false],
  ['does not exist', 'absent', '', true],
])(
  'it gives a principal legacy rights over a restored local session only for an absent config: the config %s',
  async (_label, kind, text, shown) => {
    await using daemon = setupTest();

    const store = await StateStore.open(daemon.dbPath);

    await store.writeFleet([
      {
        sessionID: toSessionID('s-old'),
        name: 'old work',
        cwd: '/tmp',
        agentSessionID: toAgentSessionID('a-old'),
        agent: 'claude',
      },
    ]);

    await store.stop();

    if (kind === 'file') {
      writeFileSync(daemon.configPath, text);
    }

    if (kind === 'directory') {
      mkdirSync(daemon.configPath);
    }

    const client = await daemon.openDaemon();

    await client.sendRequest('fleet.restore', { cols: 1, rows: 1 });

    const listed = await client.sendRequest('session.list', {}, 'client-a');

    expect(listed).toMatchObject({ sessions: shown ? [{ id: 's-old' }] : [] });
  },
);
