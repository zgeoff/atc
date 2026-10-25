import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemonProcess } from '@atc/lifecycle/testing';
import { createStateStore } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import {
  createStubClaude,
  createStubCodex,
  createStubComposer,
  createStubGrok,
  getRecord,
  getRecords,
  getString,
  registerTestCleanup,
  resolveATCCommand,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { toAgentSessionID } from '@atcx/contract';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-config-');
  const atc = resolveATCCommand();
  const composer = createStubComposer(temporaryDirectory.path);
  const configDir = join(temporaryDirectory.path, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: temporaryDirectory.path,
    atc,
    configPath: join(configDir, 'config.json'),
    claude: createStubClaude(temporaryDirectory.path, { atc, composer }),
    grok: createStubGrok(temporaryDirectory.path, { atc, composer }),
    codex: createStubCodex(temporaryDirectory.path, { atc, composer }),
  };
}

test('it starts with a broken config, prints the problem, and refuses every spawn, local included', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.configPath, '{ "targets": { "box": { "provider": "imp" } },');

  // The broken file drops the configured claude binary, so the default name
  // resolves on PATH to the stub.
  mkdirSync(join(ctx.home, 'bin'));
  symlinkSync(ctx.claude, join(ctx.home, 'bin', 'claude'));

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { PATH: `${join(ctx.home, 'bin')}:/usr/sbin:/usr/bin:/bin` },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const spawn = client.sendRequest('session.spawn', { cwd: ctx.home, target: 'local' });
  const listed = client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({
    code: 'target_config_invalid',
    data: { problem: 'config_malformed', path: ctx.configPath },
  });

  expect(listed).resolves.toStrictEqual({ sessions: [] });

  expect(daemon.readStderr()).toInclude(
    `atc daemon: config: ${ctx.configPath} cannot be used (config_malformed: `,
  );
});

test('it leaves every target unusable and names the migrate command for a config with the old agent keys', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      claudeBin: ctx.claude,
      claudeArgs: [],
      grokBin: ctx.grok,
      grokArgs: [],
      codexBin: ctx.codex,
      codexArgs: [],
      gateways: { zai: { baseURL: 'http://127.0.0.1:9' } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const listed = await client.sendRequest('agents.list');

  expect(listed['targets']).toStrictEqual([]);

  expect(listed['targetErrors']).toStrictEqual([
    {
      scope: 'config',
      problem: 'config_malformed',
      path: ctx.configPath,
      detail:
        "config.json uses the old agent keys (claudeBin, claudeArgs, grokBin, grokArgs, codexBin, codexArgs, gateways); run 'atc config migrate' to move them into agents",
    },
  ]);
});

test('it leaves each imp target unusable and the local target usable for a profile whose secret name impd refuses', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { kind: 'claude', bin: ctx.claude } },
      authProfiles: {
        notes: {
          secret: 'Notes_Key',
          host: 'notes.example.com',
          header: 'authorization',
          scheme: 'bearer',
        },
      },
      targets: {
        local: { provider: 'local-pty' },
        cloud: { provider: 'imp', url: 'http://127.0.0.1:9', tokenEnv: 'EXAMPLE_TOKEN' },
        lab: { provider: 'imp', url: 'http://127.0.0.1:9', tokenEnv: 'EXAMPLE_TOKEN' },
      },
    }),
  );

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { EXAMPLE_TOKEN: 'fixture-token' },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const listed = await client.sendRequest('agents.list');

  expect(
    getRecords(listed, 'targets').map((target) => [target['id'], target['available']]),
  ).toStrictEqual([
    ['local', true],
    ['cloud', false],
    ['lab', false],
  ]);

  expect(listed['targetErrors']).toStrictEqual([
    {
      scope: 'target',
      target: 'cloud',
      problem:
        'target "cloud" cannot use authProfiles.notes: its secret must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens, the secret names impd accepts',
    },
    {
      scope: 'target',
      target: 'lab',
      problem:
        'target "lab" cannot use authProfiles.notes: its secret must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens, the secret names impd accepts',
    },
  ]);
});

test('it lists exactly the agents of an agents map and prints no old-key line', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: {
        'claude-b': { kind: 'claude', bin: ctx.claude },
        codex: { bin: ctx.codex },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const listed = await client.sendRequest('agents.list');

  expect(getRecords(listed, 'agents').map((agent) => agent['id'])).toStrictEqual([
    'claude-b',
    'codex',
  ]);

  expect(getRecord(listed, 'spawnDefaults')['agent']).toBe('claude-b');
  expect(daemon.readStderr()).not.toInclude('old agent keys');
});

test.each([
  [
    'JSON with a syntax error at the value',
    '{ "targets": { "local": { "provider": "local-pty" } }, "token": sk_fixture_NOT_A_SECRET_1234 }',
  ],
  [
    'a defaultTarget object holding the value',
    '{ "targets": { "local": { "provider": "local-pty" } }, "defaultTarget": { "token": "sk_fixture_NOT_A_SECRET_1234" } }',
  ],
  [
    'a malformed target entry holding the value',
    '{ "targets": { "local": { "provider": "local-pty" }, "box": { "provider": 7, "token": "sk_fixture_NOT_A_SECRET_1234" } } }',
  ],
])('it prints the config problem without the config value for %s', async (_label, text) => {
  const ctx = setupTest();

  writeFileSync(ctx.configPath, text);

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const stderr = daemon.readStderr();

  expect(stderr).toInclude('atc daemon: config: ');
  expect(stderr).not.toInclude('sk_fixture_NOT_A_SECRET_1234');
});

test('it keeps the configured model and effort when a claude spawn sets neither', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: {
        claude: { kind: 'claude', bin: ctx.claude, args: ['--model', 'opus', '--effort', 'low'] },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 400,
    rows: 24,
  });

  const screen = await waitFor(async () => {
    const read = await client.sendRequest('session.screen', {
      session: getString(getRecord(ok, 'session'), 'id'),
    });

    expect(read['text']).toInclude('FAKE_CLAUDE_TERM:');

    return read;
  });

  expect(screen['text']).toInclude('args: --model opus --effort low --add-dir ');
});

test('it keeps the configured model and effort when a gateway spawn sets neither', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: {
        claude: { kind: 'claude', bin: ctx.claude, args: ['--model', 'opus', '--effort', 'low'] },
        zai: {
          kind: 'claude',
          baseURL: 'http://127.0.0.1:9',
          bin: ctx.claude,
          args: ['--model', 'opus', '--effort', 'low'],
        },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'zai',
    cols: 400,
    rows: 24,
  });

  const screen = await waitFor(async () => {
    const read = await client.sendRequest('session.screen', {
      session: getString(getRecord(ok, 'session'), 'id'),
    });

    expect(read['text']).toInclude('FAKE_CLAUDE_TERM:');

    return read;
  });

  expect(screen['text']).toInclude('args: --model opus --effort low --add-dir ');
});

test("it replaces the configured model with a claude spawn's model override", async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: {
        claude: { kind: 'claude', bin: ctx.claude, args: ['--model', 'opus', '--effort', 'low'] },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    model: 'sonnet',
    cols: 400,
    rows: 24,
  });

  const screen = await waitFor(async () => {
    const read = await client.sendRequest('session.screen', {
      session: getString(getRecord(ok, 'session'), 'id'),
    });

    expect(read['text']).toInclude('FAKE_CLAUDE_TERM:');

    return read;
  });

  expect(screen['text']).toInclude('args: --effort low --model sonnet --add-dir ');
});

test("it replaces the configured model and effort with a gateway spawn's overrides", async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: {
        claude: { kind: 'claude', bin: ctx.claude, args: ['--model', 'opus', '--effort', 'low'] },
        zai: {
          kind: 'claude',
          baseURL: 'http://127.0.0.1:9',
          bin: ctx.claude,
          args: ['--model', 'opus', '--effort', 'low'],
        },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'zai',
    model: 'haiku',
    effort: 'max',
    cols: 400,
    rows: 24,
  });

  const screen = await waitFor(async () => {
    const read = await client.sendRequest('session.screen', {
      session: getString(getRecord(ok, 'session'), 'id'),
    });

    expect(read['text']).toInclude('FAKE_CLAUDE_TERM:');

    return read;
  });

  expect(screen['text']).toInclude('args: --model haiku --effort max --add-dir ');
});

test('it restores the stored fleet by itself when the config leaves restoreFleetOnRestart unset', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.configPath, JSON.stringify({ agents: { claude: { bin: ctx.claude } } }));
  writeFileSync(join(ctx.home, 'fake-claude-own-id'), '');
  mkdirSync(join(ctx.home, '.local', 'state', 'atc'), { recursive: true });

  // The fleet a daemon that already ran here left behind.
  const seed = await createStateStore(join(ctx.home, '.local', 'state', 'atc', 'atc.db'));

  registerTestCleanup(() => seed.stop());

  await seed.writeFleet([
    buildMockFleetEntry({
      name: 'one',
      cwd: ctx.home,
      agentSessionID: toAgentSessionID('fake-a'),
    }),
    buildMockFleetEntry({
      name: 'two',
      cwd: ctx.home,
      agentSessionID: toAgentSessionID('fake-b'),
    }),
  ]);

  await seed.stop();

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  // The client sends no fleet.restore: the daemon brings the fleet back on
  // its own. A terminal lists as soon as it is adopted, before its agent has
  // run, so the wait also covers both agents' starts.
  const sessions = await waitFor(async () => {
    const reply = await client.sendRequest('session.list');

    const listed = getRecords(reply, 'sessions');

    expect(listed.map((session) => session['kind'])).toStrictEqual(['pty', 'pty']);

    expect(
      readFileSync(join(ctx.home, 'fake-claude-starts.log'), 'utf8').trim().split('\n'),
    ).toHaveLength(2);

    return listed;
  });

  expect(sessions.map((session) => session['name'])).toIncludeSameMembers(['one', 'two']);
});

test('it starts with an empty fleet beside a fleet.json and no state database', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.configPath, JSON.stringify({ agents: { claude: { bin: ctx.claude } } }));
  mkdirSync(join(ctx.home, '.local', 'state', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.local', 'state', 'atc', 'fleet.json'),
    JSON.stringify([
      { name: 'one', cwd: ctx.home, agentSessionID: 'fake-a' },
      { name: 'two', cwd: ctx.home, agentSessionID: 'fake-b' },
    ]),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  // The daemon opens its store before it answers the hello.
  await client.sendHello('atc/test');

  const store = await createStateStore(join(ctx.home, '.local', 'state', 'atc', 'atc.db'));

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([]);
});
