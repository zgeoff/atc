import { expect, test } from 'bun:test';
import { getRecord, getString, waitFor, waitForEvent } from '@atc/test-utils';
import { startStubAgentDaemon } from '../packages/app/src/test-utils/start-stub-agent-daemon';

// A daemon in the test's process whose agents are the in-process stand-ins.
function setupTest() {
  return startStubAgentDaemon({
    agents: (bins) => ({
      claude: { bin: bins.claude },
      grok: { bin: bins.grok },
      codex: { bin: bins.codex },
    }),
  });
}

test('it spawns a grok session and captures a grok descriptor from SessionStart', async () => {
  const ctx = await setupTest();

  const client = ctx.daemon.client;
  const events = ctx.daemon.events;

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
  const ctx = await setupTest();

  const client = ctx.daemon.client;

  ctx.agents.holdStart('grok');

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
  const ctx = await setupTest();

  const client = ctx.daemon.client;
  const events = ctx.daemon.events;

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
  const ctx = await setupTest();

  const client = ctx.daemon.client;
  const events = ctx.daemon.events;

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
  const ctx = await setupTest();

  const client = ctx.daemon.client;
  const events = ctx.daemon.events;

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
    const ctx = await setupTest();

    const client = ctx.daemon.client;

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

test("it runs and stores a resume request's own model and effort", async () => {
  const ctx = await setupTest();

  const client = ctx.daemon.client;

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

    expect(read['text']).toInclude('FAKE_CLAUDE_UP');

    return read;
  });

  const fleet = await waitFor(async () => {
    const listed = await client.sendRequest('fleet.list');

    expect(listed).toMatchObject({ fleet: [{ agentSessionID: 'fake-1' }] });

    return listed;
  });

  expect(screen['text']).toInclude('args: --model haiku --effort medium --add-dir ');
  expect(fleet).toMatchObject({ fleet: [{ model: 'haiku', effort: 'medium' }] });
});
