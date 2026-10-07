import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRecord } from '../src/shared/get-record';
import { toSessionID } from '../src/shared/to-session-id';
import { StateStore } from '../src/store/state-store';
import { buildMockFleetEntry } from '../src/test-utils/build-mock-fleet-entry';
import { createStubClaude } from '../src/test-utils/create-stub-claude';
import { createStubCodex } from '../src/test-utils/create-stub-codex';
import { createStubComposer } from '../src/test-utils/create-stub-composer';
import { createStubGrok } from '../src/test-utils/create-stub-grok';
import { getRecords } from '../src/test-utils/get-records';
import { getString } from '../src/test-utils/get-string';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';
import { waitFor } from '../src/test-utils/wait-for';

/**
 * A home with stub Claude, Grok, and Codex CLIs and an empty config
 * directory, for a test to write the config it is about and start a daemon
 * on.
 */
function setupTest() {
  const tmp = setupTempDir('atc-e2e-config-');
  const atc = resolveATCCommand();
  const composer = createStubComposer(tmp.dir);
  const configDir = join(tmp.dir, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: tmp.dir,
    atc,
    configPath: join(configDir, 'config.json'),
    claude: createStubClaude(tmp.dir, { atc, composer }),
    grok: createStubGrok(tmp.dir, { atc, composer }),
    codex: createStubCodex(tmp.dir, { atc, composer }),
    [Symbol.asyncDispose]: tmp[Symbol.asyncDispose],
  };
}

test('it starts with a broken config, prints the problem, and refuses every spawn, local included', async () => {
  await using ctx = setupTest();

  writeFileSync(ctx.configPath, '{ "targets": { "box": { "provider": "imp" } },');

  // The broken file drops the configured claude binary, so the default name
  // resolves on PATH to the stub.
  mkdirSync(join(ctx.home, 'bin'));
  symlinkSync(ctx.claude, join(ctx.home, 'bin', 'claude'));

  await using daemon = startDaemonProcess({
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

test('it prints one line naming the old agent keys a config still uses and loads them as before', async () => {
  await using ctx = setupTest();

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

  await using daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const listed = await client.sendRequest('agents.list');

  expect(getRecords(listed, 'agents').map((agent) => agent['id'])).toStrictEqual([
    'claude',
    'grok',
    'codex',
    'zai',
  ]);

  expect(daemon.readStderr()).toInclude(
    "atc daemon: config: config.json uses the old agent keys (claudeBin, claudeArgs, grokBin, grokArgs, codexBin, codexArgs, gateways); run 'atc config migrate' to move them into agents\n",
  );
});

test('it lists exactly the agents of an agents map and prints no old-key line', async () => {
  await using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: {
        'claude-b': { kind: 'claude', bin: ctx.claude },
        codex: { bin: ctx.codex },
      },
    }),
  );

  await using daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

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
  await using ctx = setupTest();

  writeFileSync(ctx.configPath, text);

  await using daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const stderr = daemon.readStderr();

  expect(stderr).toInclude('atc daemon: config: ');
  expect(stderr).not.toInclude('sk_fixture_NOT_A_SECRET_1234');
});

test('it keeps the configured model and effort when a spawn sets neither', async () => {
  await using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      claudeBin: ctx.claude,
      claudeArgs: ['--model', 'opus', '--effort', 'low'],
      gateways: { zai: { baseURL: 'http://127.0.0.1:9' } },
    }),
  );

  await using daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const claude = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 400, rows: 24 });

  const gateway = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'zai',
    cols: 400,
    rows: 24,
  });

  const screens = await waitFor(async () => {
    const read = await Promise.all(
      [claude, gateway].map((ok) =>
        client.sendRequest('session.screen', {
          session: getString(getRecord(ok, 'session'), 'id'),
        }),
      ),
    );

    expect(read.map((screen) => screen['text'])).toSatisfyAll((text: unknown) =>
      String(text).includes('FAKE_CLAUDE_TERM:'),
    );

    return read.map((screen) => screen['text']);
  });

  expect(screens).toSatisfyAll((text: unknown) =>
    String(text).includes('args: --model opus --effort low --settings'),
  );
});

test("it replaces the configured model and effort with a spawn's overrides", async () => {
  await using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      claudeBin: ctx.claude,
      claudeArgs: ['--model', 'opus', '--effort', 'low'],
      gateways: { zai: { baseURL: 'http://127.0.0.1:9' } },
    }),
  );

  await using daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const claude = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    model: 'sonnet',
    cols: 400,
    rows: 24,
  });

  const gateway = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'zai',
    model: 'haiku',
    effort: 'max',
    cols: 400,
    rows: 24,
  });

  const [claudeScreen, gatewayScreen] = await waitFor(async () => {
    const read = await Promise.all(
      [claude, gateway].map((ok) =>
        client.sendRequest('session.screen', {
          session: getString(getRecord(ok, 'session'), 'id'),
        }),
      ),
    );

    expect(read.map((screen) => screen['text'])).toSatisfyAll((text: unknown) =>
      String(text).includes('FAKE_CLAUDE_TERM:'),
    );

    return read.map((screen) => screen['text']);
  });

  expect(claudeScreen).toInclude('args: --effort low --model sonnet --settings');
  expect(gatewayScreen).toInclude('args: --model haiku --effort max --settings');
});

test('it restores the stored fleet by itself when the config leaves restoreFleetOnRestart unset', async () => {
  await using ctx = setupTest();

  writeFileSync(ctx.configPath, JSON.stringify({ agents: { claude: { bin: ctx.claude } } }));
  writeFileSync(join(ctx.home, 'fake-claude-own-id'), '');
  mkdirSync(join(ctx.home, '.local', 'state', 'atc'), { recursive: true });

  const seed = await StateStore.open(join(ctx.home, '.local', 'state', 'atc', 'atc.db'));

  onTestFinished(() => seed.stop());

  await seed.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s-one'), name: 'one', cwd: ctx.home }),
    buildMockFleetEntry({ sessionID: toSessionID('s-two'), name: 'two', cwd: ctx.home }),
  ]);

  await using daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  // The client sends no fleet.restore: the daemon brings the fleet back on
  // its own. A terminal lists as soon as it is adopted, before its agent has
  // run, so the wait also covers both agents' starts.
  const sessions = await waitFor(async () => {
    const reply = await client.sendRequest('session.list');

    const listed = getRecords(reply, 'sessions');

    expect({
      terminals: listed.filter((s) => s['kind'] === 'pty').length,
      starts: readFileSync(join(ctx.home, 'fake-claude-starts.log'), 'utf8').trim().split('\n')
        .length,
    }).toStrictEqual({ terminals: 2, starts: 2 });

    return listed;
  });

  expect(sessions.map((session) => session['name'])).toIncludeSameMembers(['one', 'two']);
});
