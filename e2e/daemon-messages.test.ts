import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventMsg } from '../src/protocol/protocol';
import { getRecord } from '../src/shared/get-record';
import { createStubClaude } from '../src/test-utils/create-stub-claude';
import { createStubComposer } from '../src/test-utils/create-stub-composer';
import { getRecords } from '../src/test-utils/get-records';
import { getString } from '../src/test-utils/get-string';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { runATC } from '../src/test-utils/run-atc';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';
import { waitFor } from '../src/test-utils/wait-for';
import { waitForEvent } from '../src/test-utils/wait-for-event';

/**
 * A home with a stub Claude CLI and a config that offers it, served by an
 * `atc daemon` process, with a client that has sent its handshake and
 * collects every event the daemon sends it. The daemon leaves the stored
 * fleet alone at start, so each test restores it itself.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-e2e-messages-'));
  const atc = resolveATCCommand();
  const claude = createStubClaude(tmp.dir, { atc, composer: createStubComposer(tmp.dir) });

  // The daemon spawns its sessions from the agents the config offers, and a
  // restarted daemon restores only when a test asks it to.
  mkdirSync(join(tmp.dir, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(tmp.dir, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: claude },
      },
      restoreFleetOnRestart: false,
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

test('it carries a message from accepted through delivered to answered', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-tap'), '');

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  // The session may have started without its tap connected yet, so the
  // message queues for the tap to drain.
  const sent = await ctx.client.sendRequest('session.message', {
    session: id,
    text: 'ping from test',
    from: 'e2e',
  });

  const messageID = getString(sent, 'message');

  const tapped = await waitFor(() => {
    const read = readFileSync(join(ctx.home, 'tap.jsonl'), 'utf8');

    expect(read).toInclude(messageID);

    return read;
  });

  const delivered = await waitForEvent(ctx.events, { ev: 'SessionMessage', status: 'delivered' });

  const reporter = await runATC({
    command: ctx.atc,
    args: ['report', 'answered', '--message', messageID],
    home: ctx.home,
    env: { ATC_SOCKET: ctx.daemon.reporterSocketPath, ATC_SESSION_ID: id },
    stdin: 'final text',
  });

  const answered = await waitForEvent(ctx.events, { ev: 'SessionMessage', status: 'answered' });
  const screen = await ctx.client.sendRequest('session.screen', { session: id });

  expect(tapped).toInclude('ping from test');
  expect(delivered).toMatchObject({ s: id, message: messageID, from: 'e2e' });
  expect(reporter.exitCode).toBe(0);
  expect(answered).toMatchObject({ s: id, message: messageID, answerPreview: 'final text' });
  expect(screen['text']).not.toInclude('ping from test');
});

test('it delivers a message accepted before a daemon crash to the restored session', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    resume: 'fake-1',
    cols: 80,
    rows: 24,
  });

  const originalID = getString(getRecord(spawned, 'session'), 'id');

  const sent = await ctx.client.sendRequest('session.message', {
    session: originalID,
    text: 'survive the crash',
    from: 'e2e',
  });

  const messageID = getString(sent, 'message');

  await ctx.daemon.restart('SIGKILL');

  rmSync(join(ctx.home, 'fake-claude-hold-start'));
  writeFileSync(join(ctx.home, 'fake-claude-tap'), '');

  const revived = await ctx.daemon.openClient();

  const events: EventMsg[] = [];

  revived.onEvent = (event) => {
    events.push(event);
  };

  await revived.sendHello('atc/test');

  const restored = await revived.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const tapped = await waitFor(() => {
    const read = readFileSync(join(ctx.home, 'tap.jsonl'), 'utf8');

    expect(read).toInclude(messageID);

    return read;
  });

  const delivered = await waitForEvent(events, { ev: 'SessionMessage', status: 'delivered' });
  const listed = await revived.sendRequest('session.list');

  expect(restored).toStrictEqual({ restored: 1 });
  expect(tapped).toInclude('survive the crash');
  expect(listed).toMatchObject({ sessions: [{ id: originalID }] });
  expect(delivered).toMatchObject({ s: originalID, message: messageID });
});

test('it names a message event from before a daemon crash by the restored session', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    resume: 'fake-1',
    cols: 80,
    rows: 24,
  });

  const originalID = getString(getRecord(spawned, 'session'), 'id');

  const sent = await ctx.client.sendRequest('session.message', {
    session: originalID,
    text: 'survive the crash',
    from: 'e2e',
  });

  const messageID = getString(sent, 'message');

  await ctx.daemon.restart('SIGKILL');

  rmSync(join(ctx.home, 'fake-claude-hold-start'));
  writeFileSync(join(ctx.home, 'fake-claude-tap'), '');

  const revived = await ctx.daemon.openClient();

  const events: EventMsg[] = [];

  revived.onEvent = (event) => {
    events.push(event);
  };

  await revived.sendHello('atc/test');
  await revived.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitForEvent(events, { ev: 'SessionMessage', status: 'delivered' });

  const read = await waitFor(async () => {
    const answer = await revived.sendRequest('events.read', {});

    const ours = getRecords(answer, 'events').filter((e) => e['message'] === messageID);

    expect(ours).toHaveLength(2);

    return ours;
  });

  expect(read).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: expect.toBeNumber(),
      session: originalID,
      name: expect.toBeString(),
      kind: 'message-accepted',
      detail: 'survive the crash',
      message: messageID,
    },
    {
      cursor: expect.toBeString(),
      at: expect.toBeNumber(),
      session: originalID,
      name: expect.toBeString(),
      kind: 'message-delivered',
      detail: 'survive the crash',
      message: messageID,
    },
  ]);
});

test('it names a message event sent before SessionStart by the restored session', async () => {
  await using ctx = await setupTest();

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const originalID = getString(getRecord(spawned, 'session'), 'id');

  const sent = await ctx.client.sendRequest('session.message', {
    session: originalID,
    text: 'sent before start',
    from: 'e2e',
  });

  const messageID = getString(sent, 'message');

  await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'claude'],
    home: ctx.home,
    env: { ATC_SOCKET: ctx.daemon.reporterSocketPath, ATC_SESSION_ID: originalID },
    stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fake-1' }),
  });

  await waitForEvent(ctx.events, { ev: 'SessionState', session: { agentSessionID: 'fake-1' } });

  await ctx.daemon.restart('SIGKILL');

  rmSync(join(ctx.home, 'fake-claude-hold-start'));

  const revived = await ctx.daemon.openClient();

  await revived.sendHello('atc/test');
  await revived.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await revived.sendRequest('session.list');

  const read = await waitFor(async () => {
    const answer = await revived.sendRequest('events.read', {});

    const ours = getRecords(answer, 'events').filter((e) => e['message'] === messageID);

    expect(ours).toHaveLength(1);

    return ours;
  });

  const [restored] = getRecords(listed, 'sessions');

  if (restored === undefined) {
    throw new Error('no session restored');
  }

  expect(restored['id']).toBe(originalID);

  expect(read).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: expect.toBeNumber(),
      session: originalID,
      name: restored['name'],
      kind: 'message-accepted',
      detail: 'sent before start',
      message: messageID,
    },
  ]);
});
