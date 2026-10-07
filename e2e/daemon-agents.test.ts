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
 * A home with stub Claude, Grok, and Codex CLIs and a config that offers
 * them and a Claude gateway, served by an `atc daemon` process, with a
 * client that has sent its handshake and collects every event the daemon
 * sends it.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-e2e-agents-'));
  const atc = resolveATCCommand();
  const composer = createStubComposer(tmp.dir);
  const claude = createStubClaude(tmp.dir, { atc, composer });

  // The daemon spawns its sessions from the agents the config offers; the
  // gateway runs the stub Claude against an address nothing serves.
  mkdirSync(join(tmp.dir, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(tmp.dir, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: claude },
        grok: { bin: createStubGrok(tmp.dir, { atc, composer }) },
        codex: { bin: createStubCodex(tmp.dir, { atc, composer }) },
        zai: { kind: 'claude', bin: claude, baseURL: 'http://127.0.0.1:9' },
      },
    }),
  );

  const daemon = stack.use(startDaemonProcess({ command: atc, home: tmp.dir }));

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const owned = stack.move();

  return {
    home: tmp.dir,
    atc,
    daemon,
    client,
    events,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it spawns a grok session and captures a grok descriptor from SessionStart', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  const listed = await ctx.client.sendRequest('session.list');

  expect(ok).toMatchObject({ session: { agent: 'grok', alive: true } });

  expect(listed).toMatchObject({
    sessions: [
      { state: 'needs_you', agentSessionID: 'fake-grok-1', agent: 'grok', lastMsg: 'allow edit?' },
    ],
  });
});

test('it yanks a bare grok command for a grok session before its SessionStart', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-grok-hold-start'), '');

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  const answer = await ctx.client.sendRequest('session.resumeCommand', { session: id });

  expect(answer).toStrictEqual({ command: `cd '${ctx.home}' && grok` });
});

test('it yanks grok --resume for a grok session once its id is captured', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(ctx.events, {
    ev: 'SessionState',
    session: { agentSessionID: 'fake-grok-1' },
  });

  const answer = await ctx.client.sendRequest('session.resumeCommand', { session: id });

  expect(answer).toStrictEqual({
    command: `cd '${ctx.home}' && grok --resume fake-grok-1`,
  });
});

test('it spawns a codex session and captures its descriptor from SessionStart', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'done' } });

  const listed = await ctx.client.sendRequest('session.list');

  expect(ok).toMatchObject({ session: { agent: 'codex', alive: true } });

  expect(listed).toMatchObject({
    sessions: [{ state: 'done', agentSessionID: 'fake-codex-1', agent: 'codex' }],
  });
});

test('it builds a codex resume command once the codex id is captured', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'codex',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(ctx.events, {
    ev: 'SessionState',
    session: { agentSessionID: 'fake-codex-1' },
  });

  const answer = await ctx.client.sendRequest('session.resumeCommand', { session: id });

  expect(answer).toStrictEqual({
    command: `cd '${ctx.home}' && codex resume fake-codex-1`,
  });
});

test.each([['grok'], ['codex']])(
  'it answers session.read on a %s session with unsupported',
  async (agent) => {
    await using ctx = await setupTest();

    const ok = await ctx.client.sendRequest('session.spawn', {
      cwd: ctx.home,
      agent,
      cols: 80,
      rows: 24,
    });

    const id = getString(getRecord(ok, 'session'), 'id');

    expect(ctx.client.sendRequest('session.read', { session: id })).rejects.toMatchObject({
      code: 'unsupported',
    });
  },
);

test('it starts a Claude session with the atc-bridge mod folder', async () => {
  await using ctx = await setupTest();

  const bridgeDir = join(ctx.daemon.stateDir, 'atc-bridge');

  // Wide enough that the echoed args line never wraps mid-path.
  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 400, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  const screen = await waitFor(async () => {
    const read = await ctx.client.sendRequest('session.screen', { session: id });

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
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'zai',
    cols: 400,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  const screen = await waitFor(async () => {
    const read = await ctx.client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_TERM:');

    return read;
  });

  expect(screen['text']).toInclude(`--plugin-dir ${join(ctx.daemon.stateDir, 'atc-bridge')}`);
});

test("it runs and stores a resume request's own model and effort", async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    resume: 'fake-1',
    model: 'haiku',
    effort: 'medium',
    cols: 400,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  const screen = await waitFor(async () => {
    const read = await ctx.client.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_TERM:');

    return read;
  });

  const fleet = await waitFor(async () => {
    const listed = await ctx.client.sendRequest('fleet.list');

    expect(listed).toMatchObject({ fleet: [{ agentSessionID: 'fake-1' }] });

    return listed;
  });

  expect(screen['text']).toInclude('args: --model haiku --effort medium --settings');
  expect(fleet).toMatchObject({ fleet: [{ model: 'haiku', effort: 'medium' }] });
});
