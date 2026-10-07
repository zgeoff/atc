import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventMsg } from '../src/protocol/protocol';
import { findDaemonRecord } from '../src/shared/find-daemon-record';
import { getRecord } from '../src/shared/get-record';
import { toAgentSessionID } from '../src/shared/to-agent-session-id';
import { toSessionID } from '../src/shared/to-session-id';
import { StateStore } from '../src/store/state-store';
import { buildMockFleetEntry } from '../src/test-utils/build-mock-fleet-entry';
import { createStubClaude } from '../src/test-utils/create-stub-claude';
import { createStubComposer } from '../src/test-utils/create-stub-composer';
import { createStubGrok } from '../src/test-utils/create-stub-grok';
import { getRecords } from '../src/test-utils/get-records';
import { getString } from '../src/test-utils/get-string';
import { KEYS } from '../src/test-utils/keys';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';
import { waitFor } from '../src/test-utils/wait-for';
import { waitForEvent } from '../src/test-utils/wait-for-event';

/**
 * A home with stub Claude and Grok CLIs and a config that offers them,
 * served by an `atc daemon` process, with a client that has sent its
 * handshake and collects every event the daemon sends it. The daemon leaves
 * the stored fleet alone at start, so each test restores it itself.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-e2e-restore-'));
  const atc = resolveATCCommand();
  const composer = createStubComposer(tmp.dir);

  // The daemon spawns its sessions from the agents the config offers, and a
  // restarted daemon restores only when a test asks it to.
  mkdirSync(join(tmp.dir, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(tmp.dir, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: createStubClaude(tmp.dir, { atc, composer }) },
        grok: { bin: createStubGrok(tmp.dir, { atc, composer }) },
      },
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = stack.use(
    startDaemonProcess({
      command: atc,
      home: tmp.dir,

      // A boot wait far longer than any test, so a revive that boots shows
      // that the start or death of the one before it released the wait.
      env: { ATC_RESTORE_BOOT_TIMEOUT_MS: '60000' },
    }),
  );

  const client = await daemon.openClient();

  const events: EventMsg[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  const owned = stack.move();

  return {
    home: tmp.dir,
    daemon,
    client,
    events,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it restores the fleet cold after a daemon crash', async () => {
  await using ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  await ctx.daemon.restart('SIGKILL');

  const revived = await ctx.daemon.openClient();

  await revived.sendHello('atc/test');

  const restored = await revived.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const listed = await revived.sendRequest('session.list');

  expect(restored).toStrictEqual({ restored: 1 });
  expect(listed).toMatchObject({ sessions: [{ agentSessionID: 'fake-1', alive: true }] });
});

test('it starts a daemon on the state directory of one killed with SIGKILL', async () => {
  await using ctx = await setupTest();

  await ctx.daemon.restart('SIGKILL');

  const revived = await ctx.daemon.openClient();

  await revived.sendHello('atc/test');

  expect(ctx.daemon.proc.exitCode).toBeNull();

  expect(findDaemonRecord(join(ctx.daemon.stateDir, 'daemon.json'))).toMatchObject({
    pid: ctx.daemon.proc.pid,
  });
});

test('it restores a killed session as exited across a daemon restart', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  await ctx.client.sendRequest('session.kill', { session: id });

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { lastMsg: 'killed' } });

  await ctx.daemon.restart('SIGKILL');

  const revived = await ctx.daemon.openClient();

  await revived.sendHello('atc/test');

  const restored = await revived.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const listed = await revived.sendRequest('session.list');

  expect(restored).toStrictEqual({ restored: 1 });

  expect(listed).toMatchObject({
    sessions: [
      {
        agentSessionID: 'fake-1',
        state: 'exited',
        lastMsg: 'killed',
        alive: false,
        kind: 'headless',
      },
    ],
  });
});

test('it restores a stored exited row once and nothing on a second restore', async () => {
  await using ctx = await setupTest();

  const seed = await StateStore.open(join(ctx.daemon.stateDir, 'atc.db'));

  onTestFinished(() => seed.stop());

  await seed.writeFleet([buildMockFleetEntry({ cwd: ctx.home, exited: true })]);
  await seed.stop();

  const first = await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const second = await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect([first, second]).toStrictEqual([{ restored: 1 }, { restored: 0 }]);
});

test('it revives the fleet one boot at a time, gated on SessionStart', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-own-id'), '');
  writeFileSync(join(ctx.home, 'fake-claude-gate'), '');

  const seed = await StateStore.open(join(ctx.daemon.stateDir, 'atc.db'));

  onTestFinished(() => seed.stop());

  await seed.writeFleet(
    ['one', 'two', 'three'].map((name) =>
      buildMockFleetEntry({ sessionID: toSessionID(`s-${name}`), name, cwd: ctx.home }),
    ),
  );

  const restored = await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const immediate = await ctx.client.sendRequest('session.list');

  // The first revive holds its start until a line arrives, so the rest stay
  // queued behind it until the test lets it go.
  const booting = getRecords(immediate, 'sessions').find((s) => s['kind'] === 'pty');

  if (booting === undefined) {
    throw new Error('no restored session has a terminal');
  }

  await ctx.client.sendRequest('session.input', { session: booting['id'], d: KEYS.enter });

  await waitForEvent(ctx.events, {
    ev: 'SessionState',
    session: { id: 's-three', kind: 'pty', agentSessionID: 's-three' },
  });

  const settled = await ctx.client.sendRequest('session.list');

  expect(restored).toStrictEqual({ restored: 3 });

  expect(getRecords(immediate, 'sessions')).toIncludeSameMembers([
    expect.objectContaining({ id: 's-one', kind: 'pty' }),
    expect.objectContaining({ id: 's-two', lastMsg: 'waiting to restore' }),
    expect.objectContaining({ id: 's-three', lastMsg: 'waiting to restore' }),
  ]);

  expect(getRecords(immediate, 'sessions').filter((s) => s['kind'] === 'pty')).toHaveLength(1);
  expect(getRecords(settled, 'sessions')).toHaveLength(3);

  expect(getRecords(settled, 'sessions')).toSatisfyAll(
    (session: Readonly<Record<string, unknown>>) => session['kind'] === 'pty',
  );
});

test('it moves on to the next revive when one dies before announcing itself', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-own-id'), '');
  writeFileSync(join(ctx.home, 'fake-claude-dies-agent-dying'), '');

  const seed = await StateStore.open(join(ctx.daemon.stateDir, 'atc.db'));

  onTestFinished(() => seed.stop());

  // A restore keeps the stored order for sessions with no recency, so the
  // dying revive boots first and the survivor waits behind it.
  await seed.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-dying'),
      agentSessionID: toAgentSessionID('agent-dying'),
      cwd: ctx.home,
    }),
    buildMockFleetEntry({ sessionID: toSessionID('s-survivor'), cwd: ctx.home }),
  ]);

  const restored = await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const survivor = await waitForEvent(ctx.events, {
    ev: 'SessionState',
    session: { id: 's-survivor', kind: 'pty' },
  });

  expect(restored).toStrictEqual({ restored: 2 });
  expect(survivor).toMatchObject({ session: { alive: true } });
});

test('it revives the fleet most recently active first', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-own-id'), '');

  const seed = await StateStore.open(join(ctx.daemon.stateDir, 'atc.db'));

  onTestFinished(() => seed.stop());

  await seed.writeFleet([
    buildMockFleetEntry({ name: 'one', cwd: ctx.home, agentSessionID: toAgentSessionID('fake-a') }),
    buildMockFleetEntry({ name: 'two', cwd: ctx.home, agentSessionID: toAgentSessionID('fake-b') }),
    buildMockFleetEntry({
      name: 'three',
      cwd: ctx.home,
      agentSessionID: toAgentSessionID('fake-c'),
    }),
  ]);

  const db = new Database(join(ctx.daemon.stateDir, 'atc.db'));

  onTestFinished(() => {
    db.close();
  });

  // The event trail dates 'three' most recent and 'one' oldest, inverting
  // the stored fleet order.
  db.run(
    'INSERT INTO events (ts, atc_id, event, message, session_id) VALUES ' +
      "('2026-08-14T00:00:01.000Z', 's1', 'Stop', NULL, 'fake-a')," +
      "('2026-08-14T00:00:03.000Z', 's2', 'Stop', NULL, 'fake-c')," +
      "('2026-08-14T00:00:02.000Z', 's3', 'Stop', NULL, 'fake-b')",
  );

  const restored = await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitForEvent(ctx.events, { ev: 'SessionAdded', session: { name: 'one' } });

  expect(restored).toStrictEqual({ restored: 3 });

  expect(ctx.events.filter((e) => e.ev === 'SessionAdded')).toMatchObject([
    { session: { name: 'three' } },
    { session: { name: 'two' } },
    { session: { name: 'one' } },
  ]);
});

test('it restores a grok session via grok --resume, not claude --resume', async () => {
  await using ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    agent: 'grok',
    cols: 80,
    rows: 24,
  });

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'needs_you' } });

  await ctx.daemon.restart('SIGKILL');

  const revived = await ctx.daemon.openClient();

  const replay: EventMsg[] = [];

  revived.onEvent = (event) => {
    replay.push(event);
  };

  await revived.sendHello('atc/test');

  const restored = await revived.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const listed = await revived.sendRequest('session.list');

  const [session] = getRecords(listed, 'sessions');

  if (session === undefined) {
    throw new Error('no restored grok session');
  }

  await revived.sendRequest('session.attach', { session: session['id'], cols: 80, rows: 24 });

  const output = await waitForEvent(replay, {
    ev: 'SessionOutput',
    d: expect.stringContaining('FAKE_GROK_UP'),
  });

  expect(restored).toStrictEqual({ restored: 1 });

  expect(listed).toMatchObject({
    sessions: [{ agentSessionID: 'fake-grok-1', agent: 'grok', alive: true }],
  });

  expect(output['d']).toInclude('--resume fake-grok-1');
  expect(output['d']).not.toInclude('claude --resume');
  expect(output['d']).not.toInclude('FAKE_CLAUDE_UP');
});

test('it keeps the spawn prompt and latest result across a daemon restart', async () => {
  await using ctx = await setupTest();

  writeFileSync(
    join(ctx.home, 'fake-claude-events.jsonl'),
    `${JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'fake-1',
      last_assistant_message: 'All tests pass.',
    })}\n`,
  );

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    prompt: 'fix the auth bug',
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  // The turn's end reaching the daemon is waited for on its own, so a slow
  // hook delivery and a lost fleet write fail at different lines.
  await waitForEvent(ctx.events, { ev: 'SessionState', session: { state: 'done' } });

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('fleet.list');

    expect(listed).toMatchObject({
      fleet: [
        {
          prompt: 'fix the auth bug',
          result: 'All tests pass.',
          transcriptPath: join(ctx.home, 'fake-transcript.jsonl'),
        },
      ],
    });
  });

  await ctx.daemon.restart('SIGKILL');

  const revived = await ctx.daemon.openClient();

  await revived.sendHello('atc/test');
  await revived.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const record = await revived.sendRequest('session.get', { session: id });

  expect(record).toMatchObject({ prompt: 'fix the auth bug', result: 'All tests pass.' });
});

test("it revives a restored session with the spawn's model and effort", async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    model: 'opus[1m]',
    effort: 'xhigh',
    cols: 400,
    rows: 24,
  });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('fleet.list');

    expect(listed).toMatchObject({
      fleet: [{ agentSessionID: 'fake-1', model: 'opus[1m]', effort: 'xhigh' }],
    });
  });

  await ctx.daemon.restart('SIGKILL');

  const revived = await ctx.daemon.openClient();

  await revived.sendHello('atc/test');
  await revived.sendRequest('fleet.restore', { cols: 400, rows: 24 });

  const screen = await waitFor(async () => {
    const read = await revived.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_TERM:');

    return read;
  });

  expect(screen['text']).toInclude('args: --model opus[1m] --effort xhigh --settings');
  expect(screen['text']).toInclude('--resume fake-1');
});

test('it revives a restored session that has no model or effort without either flag', async () => {
  await using ctx = await setupTest();

  const ok = await ctx.client.sendRequest('session.spawn', { cwd: ctx.home, cols: 400, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  await waitFor(async () => {
    const listed = await ctx.client.sendRequest('fleet.list');

    expect(listed).toMatchObject({ fleet: [{ agentSessionID: 'fake-1' }] });
  });

  await ctx.daemon.restart('SIGKILL');

  const revived = await ctx.daemon.openClient();

  await revived.sendHello('atc/test');

  const stored = await revived.sendRequest('fleet.list');

  await revived.sendRequest('fleet.restore', { cols: 400, rows: 24 });

  const screen = await waitFor(async () => {
    const read = await revived.sendRequest('session.screen', { session: id });

    expect(read['text']).toInclude('FAKE_CLAUDE_TERM:');

    return read;
  });

  const [entry] = getRecords(stored, 'fleet');

  if (entry === undefined) {
    throw new Error('the stored fleet holds no entry');
  }

  expect(entry).not.toContainAnyKeys(['model', 'effort']);
  expect(screen['text']).toInclude('args: --settings');
  expect(screen['text']).toInclude('--resume fake-1');
});
