import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemonProcess } from '@atc/lifecycle/testing';
import {
  createStubClaude,
  createStubComposer,
  getRecord,
  getRecords,
  getString,
  resolveATCCommand,
  runATC,
  setupTempDir,
  waitFor,
  waitForEvent,
} from '@atc/test-utils';
import type { DaemonEvent } from '@atcx/contract';
import invariant from 'tiny-invariant';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-messages-');
  const atc = resolveATCCommand();
  const configDir = join(temporaryDirectory.path, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: temporaryDirectory.path,
    atc,
    configPath: join(configDir, 'config.json'),
    claude: createStubClaude(temporaryDirectory.path, {
      atc,
      composer: createStubComposer(temporaryDirectory.path),
    }),
  };
}

test('it carries a message from queued through delivered to answered', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(join(ctx.home, 'fake-claude-tap'), '');

  const spawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  // The session may have started without its tap connected yet, so the
  // message queues for the tap to drain.
  const sent = await client.sendRequest('session.message', {
    session: id,
    text: 'ping from test',
  });

  const messageID = getString(sent, 'message');

  const tapped = await waitFor(() => {
    const read = readFileSync(join(ctx.home, 'tap.jsonl'), 'utf8');

    expect(read).toInclude(messageID);

    return read;
  });

  const delivered = await waitForEvent(events, { ev: 'SessionMessage', status: 'delivered' });

  const reporter = await runATC({
    command: ctx.atc,
    args: ['answer', '--message', messageID],
    home: ctx.home,
    env: { ATC_SOCKET: daemon.reporterSocketPath, ATC_SESSION_ID: id },
    stdin: 'final text',
  });

  const answered = await waitForEvent(events, { ev: 'SessionMessage', status: 'answered' });
  const screen = await client.sendRequest('session.screen', { session: id });

  expect(tapped).toInclude('ping from test');

  expect(delivered).toMatchObject({
    sessionID: id,
    message: messageID,
    from: 'owner',
    sender: { kind: 'owner', name: 'owner' },
  });

  expect(reporter.exitCode).toBe(0);

  expect(answered).toMatchObject({
    sessionID: id,
    message: messageID,
    answerPreview: 'final text',
  });

  expect(getString(screen, 'text')).not.toInclude('ping from test');
});

test('it delivers a message queued before a daemon crash to the restored session', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },

      // A restarted daemon restores only when the test asks it to.
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const spawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    resume: 'fake-1',
    cols: 80,
    rows: 24,
  });

  const originalID = getString(getRecord(spawned, 'session'), 'id');

  const sent = await client.sendRequest('session.message', {
    session: originalID,
    text: 'survive the crash',
  });

  const messageID = getString(sent, 'message');

  const before = await client.sendRequest('message.get', { message: messageID });

  await daemon.restart('SIGKILL');

  rmSync(join(ctx.home, 'fake-claude-hold-start'));
  writeFileSync(join(ctx.home, 'fake-claude-tap'), '');

  const revived = await daemon.openClient();

  const events: DaemonEvent[] = [];

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

  expect(before).toMatchObject({ status: 'queued' });
  expect(restored).toStrictEqual({ restored: 1 });
  expect(tapped).toInclude('survive the crash');
  expect(listed).toMatchObject({ sessions: [{ id: originalID }] });
  expect(delivered).toMatchObject({ sessionID: originalID, message: messageID });
});

test('it names a message event from before a daemon crash by the restored session', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },

      // A restarted daemon restores only when the test asks it to.
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const spawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    resume: 'fake-1',
    cols: 80,
    rows: 24,
  });

  const originalID = getString(getRecord(spawned, 'session'), 'id');

  const sent = await client.sendRequest('session.message', {
    session: originalID,
    text: 'survive the crash',
  });

  const messageID = getString(sent, 'message');

  const before = await client.sendRequest('message.get', { message: messageID });

  await daemon.restart('SIGKILL');

  rmSync(join(ctx.home, 'fake-claude-hold-start'));
  writeFileSync(join(ctx.home, 'fake-claude-tap'), '');

  const revived = await daemon.openClient();

  const events: DaemonEvent[] = [];

  revived.onEvent = (event) => {
    events.push(event);
  };

  await revived.sendHello('atc/test');
  await revived.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitForEvent(events, { ev: 'SessionMessage', status: 'delivered' });

  const read = await waitFor(async () => {
    const answer = await revived.sendRequest('events.read', {});

    const ours = getRecords(answer, 'events').filter((entry) => entry['message'] === messageID);

    expect(ours).toHaveLength(2);

    return ours;
  });

  expect(before).toMatchObject({ status: 'queued' });

  expect(read).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: expect.toBeNumber(),
      session: originalID,
      name: expect.toBeString(),
      kind: 'message-queued',
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
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },

      // A restarted daemon restores only when the test asks it to.
      restoreFleetOnRestart: false,
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(join(ctx.home, 'fake-claude-hold-start'), '');

  const spawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const originalID = getString(getRecord(spawned, 'session'), 'id');

  const sent = await client.sendRequest('session.message', {
    session: originalID,
    text: 'sent before start',
  });

  const messageID = getString(sent, 'message');

  await runATC({
    command: ctx.atc,
    args: ['hook-report', '--agent', 'claude'],
    home: ctx.home,
    env: { ATC_SOCKET: daemon.reporterSocketPath, ATC_SESSION_ID: originalID },
    stdin: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'fake-1' }),
  });

  await waitForEvent(events, { ev: 'SessionState', session: { agentSessionID: 'fake-1' } });

  await daemon.restart('SIGKILL');

  rmSync(join(ctx.home, 'fake-claude-hold-start'));

  const revived = await daemon.openClient();

  await revived.sendHello('atc/test');
  await revived.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await revived.sendRequest('session.list');

  const read = await waitFor(async () => {
    const answer = await revived.sendRequest('events.read', {});

    const ours = getRecords(answer, 'events').filter((entry) => entry['message'] === messageID);

    expect(ours).toHaveLength(1);

    return ours;
  });

  const [restored] = getRecords(listed, 'sessions');

  invariant(restored !== undefined, 'no session restored');

  expect(restored['id']).toBe(originalID);

  expect(read).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: expect.toBeNumber(),
      session: originalID,
      name: restored['name'],
      kind: 'message-queued',
      detail: 'sent before start',
      message: messageID,
    },
  ]);
});

test('it keeps a message answered through the answer command across a daemon restart that revives its session', async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      agents: { claude: { bin: ctx.claude } },
      restoreFleetOnRestart: true,
    }),
  );

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  const events: DaemonEvent[] = [];

  client.onEvent = (event) => {
    events.push(event);
  };

  await client.sendHello('atc/test');

  writeFileSync(join(ctx.home, 'fake-claude-tap'), '');

  const spawned = await client.sendRequest('session.spawn', {
    cwd: ctx.home,
    cols: 80,
    rows: 24,
  });

  const id = getString(getRecord(spawned, 'session'), 'id');

  const sent = await client.sendRequest('session.message', {
    session: id,
    text: 'tidy the release notes',
  });

  const messageID = getString(sent, 'message');

  await waitForEvent(events, { ev: 'SessionMessage', status: 'delivered' });

  // The answer tool of the atc-bridge mod runs this command.
  await runATC({
    command: ctx.atc,
    args: ['answer', '--message', messageID],
    home: ctx.home,
    env: { ATC_SOCKET: daemon.reporterSocketPath, ATC_SESSION_ID: id },
    stdin: 'the notes are tidy',
  });

  await waitForEvent(events, { ev: 'SessionMessage', status: 'answered' });

  await daemon.restart('SIGTERM');

  const revived = await daemon.openClient();

  await revived.sendHello('atc/test');

  // The inbox drains in sent order, so a later message that reaches the
  // revived tap shows the tap was handed everything before it.
  const later = await revived.sendRequest('session.message', {
    session: id,
    text: 'list the open branches',
  });

  const tapped = await waitFor(() => {
    const read = readFileSync(join(ctx.home, 'tap.jsonl'), 'utf8');

    expect(read).toInclude(getString(later, 'message'));

    return read;
  });

  const read = await revived.sendRequest('message.get', { message: messageID });

  expect(read).toMatchObject({ status: 'answered', answer: 'the notes are tidy' });
  expect(tapped.split('\n').filter((line) => line.includes(messageID))).toHaveLength(1);
});
