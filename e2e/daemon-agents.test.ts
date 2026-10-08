import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventMsg } from '../src/protocol/protocol';
import { getRecord } from '../src/shared/get-record';
import { createStubClaude } from '../src/test-utils/create-stub-claude';
import { createStubCodex } from '../src/test-utils/create-stub-codex';
import { createStubComposer } from '../src/test-utils/create-stub-composer';
import { createStubGrok } from '../src/test-utils/create-stub-grok';
import { getString } from '../src/test-utils/get-string';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';
import { waitFor } from '../src/test-utils/wait-for';
import { waitForEvent } from '../src/test-utils/wait-for-event';

/**
 * A home with stub Claude, Grok, and Codex CLIs for the `atc daemon` that
 * each test starts once it has written the config offering them.
 */
function setupTest() {
  const tmp = setupTempDir('atc-e2e-agents-');
  const atc = resolveATCCommand();
  const composer = createStubComposer(tmp.dir);

  return {
    home: tmp.dir,
    atc,
    claude: createStubClaude(tmp.dir, { atc, composer }),
    grok: createStubGrok(tmp.dir, { atc, composer }),
    codex: createStubCodex(tmp.dir, { atc, composer }),
  };
}

test('it spawns a grok session and captures a grok descriptor from SessionStart', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: ctx.claude },
        grok: { bin: ctx.grok },
        codex: { bin: ctx.codex },

        // The gateway runs the stub Claude against an address nothing serves.
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  await waitForEvent(events, { ev: 'SessionState', session: { state: 'needs_you' } });

  const listed = await client.sendRequest('session.list');

  expect(ok).toMatchObject({ session: { agent: 'grok', alive: true } });

  expect(listed).toMatchObject({
    sessions: [
      { state: 'needs_you', agentSessionID: 'fake-grok-1', agent: 'grok', lastMsg: 'allow edit?' },
    ],
  });
});

test('it yanks a bare grok command for a grok session before its SessionStart', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: ctx.claude },
        grok: { bin: ctx.grok },
        codex: { bin: ctx.codex },

        // The gateway runs the stub Claude against an address nothing serves.
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(join(ctx.home, 'fake-grok-hold-start'), '');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  const answer = await client.sendRequest('session.resumeCommand', { session: id });

  expect(answer).toStrictEqual({ command: `cd '${ctx.home}' && grok` });
});

test('it yanks grok --resume for a grok session once its id is captured', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: ctx.claude },
        grok: { bin: ctx.grok },
        codex: { bin: ctx.codex },

        // The gateway runs the stub Claude against an address nothing serves.
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(events, {
    ev: 'SessionState',
    session: { agentSessionID: 'fake-grok-1' },
  });

  const answer = await client.sendRequest('session.resumeCommand', { session: id });

  expect(answer).toStrictEqual({
    command: `cd '${ctx.home}' && grok --resume fake-grok-1`,
  });
});

test('it spawns a codex session and captures its descriptor from SessionStart', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: ctx.claude },
        grok: { bin: ctx.grok },
        codex: { bin: ctx.codex },

        // The gateway runs the stub Claude against an address nothing serves.
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  await waitForEvent(events, { ev: 'SessionState', session: { state: 'done' } });

  const listed = await client.sendRequest('session.list');

  expect(ok).toMatchObject({ session: { agent: 'codex', alive: true } });

  expect(listed).toMatchObject({
    sessions: [{ state: 'done', agentSessionID: 'fake-codex-1', agent: 'codex' }],
  });
});

test('it builds a codex resume command once the codex id is captured', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: ctx.claude },
        grok: { bin: ctx.grok },
        codex: { bin: ctx.codex },

        // The gateway runs the stub Claude against an address nothing serves.
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(events, {
    ev: 'SessionState',
    session: { agentSessionID: 'fake-codex-1' },
  });

  const answer = await client.sendRequest('session.resumeCommand', { session: id });

  expect(answer).toStrictEqual({
    command: `cd '${ctx.home}' && codex resume fake-codex-1`,
  });
});

test.each([['grok'], ['codex']])(
  'it answers session.read on a %s session with unsupported',
  async (agent) => {
    const ctx = setupTest();

    mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

    writeFileSync(
      join(ctx.home, '.config', 'atc', 'config.json'),
      JSON.stringify({
        agents: {
          claude: { bin: ctx.claude },
          grok: { bin: ctx.grok },
          codex: { bin: ctx.codex },

          // The gateway runs the stub Claude against an address nothing serves.
          zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
        },
      }),
    );

    const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

    const client = await daemon.openClient();

    const events: EventMsg[] = [];

    client.onEvent = (event) => {
      events.push(event);
    };

    await client.sendHello('atc/test');

    const ok = await client.sendRequest('session.spawn', {
      cwd: ctx.home,
      agent,
      cols: 80,
      rows: 24,
    });

    const id = getString(getRecord(ok, 'session'), 'id');

    expect(client.sendRequest('session.read', { session: id })).rejects.toMatchObject({
      code: 'unsupported',
    });
  },
);

test('it starts a Claude session with the atc-bridge mod folder', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: ctx.claude },
        grok: { bin: ctx.grok },
        codex: { bin: ctx.codex },

        // The gateway runs the stub Claude against an address nothing serves.
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const bridgeDir = join(daemon.stateDir, 'atc-bridge');

  // Wide enough that the echoed args line never wraps mid-path.
  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 400, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  const screen = await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_TERM:');

    return read;
  });

  expect(screen['text']).toInclude(`--plugin-dir ${bridgeDir}`);

  expect(readFileSync(join(bridgeDir, '.claude-plugin', 'plugin.json'), 'utf8')).toInclude(
    '"name": "atc-bridge"',
  );

  expect(readFileSync(join(bridgeDir, 'hooks', 'atc-cli.ts'), 'utf8')).toIncludeMultiple(ctx.atc);
});

test('it starts a gateway session with the atc-bridge mod folder', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: ctx.claude },
        grok: { bin: ctx.grok },
        codex: { bin: ctx.codex },

        // The gateway runs the stub Claude against an address nothing serves.
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'zai',
    cols: 400,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  const screen = await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_TERM:');

    return read;
  });

  expect(screen['text']).toInclude(`--plugin-dir ${join(daemon.stateDir, 'atc-bridge')}`);
});

test("it runs and stores a resume request's own model and effort", async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.home, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: ctx.claude },
        grok: { bin: ctx.grok },
        codex: { bin: ctx.codex },

        // The gateway runs the stub Claude against an address nothing serves.
        zai: { kind: 'claude', bin: ctx.claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    resume: 'fake-1',
    model: 'haiku',
    effort: 'medium',
    cols: 400,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  const screen = await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_TERM:');

    return read;
  });

  const fleet = await waitFor(async () => {
    const listed = await client.sendRequest('fleet.list');

    expect(listed).toMatchObject({ fleet: [{ agentSessionID: 'fake-1' }] });

    return listed;
  });

  expect(screen['text']).toInclude('args: --model haiku --effort medium --settings');
  expect(fleet).toMatchObject({ fleet: [{ model: 'haiku', effort: 'medium' }] });
});
