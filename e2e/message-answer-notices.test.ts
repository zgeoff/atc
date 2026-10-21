import { expect, mock, test } from 'bun:test';
import { isRecord, toMessageID, toSessionID } from '@atc/core';
import { createClaudeAdapter } from '@atc/harness-claude';
import type { DaemonEvent } from '@atc/protocol';
import { createStateStore } from '@atc/store';
import {
  buildMockAgentAdapter,
  buildMockAgentEntry,
  buildMockHostServices,
  getString,
  registerTestCleanup,
  spawnNamedSession,
  startStubTap,
  waitFor,
} from '@atc/test-utils';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

async function setupTest(
  planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] })),
  options: { readonly restoreFleetOnRestart?: boolean } = {},
) {
  const claude = createClaudeAdapter(
    buildMockAgentEntry({ id: 'claude' }),
    { authProfiles: new Map() },
    buildMockHostServices(),
  );

  const noteIgnored = mock();

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        takesMessages: true,
        planSpawn,

        // Hook lines read as Claude's read, so a SessionStart makes a session revivable.
        planHookEvents: (hook) => claude.planHookEvents(hook),
      }),
      onNoteIgnored: noteIgnored,
      restoreFleetOnRestart: options.restoreFleetOnRestart === true,

      // The stand-in never reports its boot, so a short cap keeps the
      // restore from holding each session up.
      restoreBootTimeoutMs: 10,
    }),
  });

  const send = (method: string, params?: Readonly<Record<string, unknown>>) =>
    daemon.client.sendRequest(method, params);

  const sender = await spawnNamedSession(send, 'sender', daemon.directory);
  const recipient = await spawnNamedSession(send, 'recipient', daemon.directory);

  // Its handshake holds the sender's id, as an `atc mcp` started in that session sends it.
  const inside = await daemon.openClient({ session: sender });

  return { daemon, sender, recipient, inside, noteIgnored };
}

test('it hands the sending session an answer notice with the answer once the recipient answers', async () => {
  const ctx = await setupTest();
  const tapClient = await ctx.daemon.openClient();
  const tap = await startStubTap(tapClient, ctx.sender, { notices: true });

  const sent = await ctx.inside.sendRequest('session.message', {
    session: ctx.recipient,
    text: 'is the build green',
  });

  await ctx.daemon.sendHookLines({
    atcId: ctx.recipient,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'the build is green' },
  });

  await waitFor(() => {
    expect<unknown[]>(tap.notices).toStrictEqual([
      {
        ev: 'InboxNotice',
        sessionID: ctx.sender,
        message: getString(sent, 'message'),
        from: ctx.recipient,
        status: 'answered',
        answer: 'the build is green',
        at: expect.any(Number),
      },
    ]);
  });

  expect(tap.messages).toStrictEqual([]);
});

test('it hands the sending session an unanswered notice with the reason when the turn is interrupted', async () => {
  const ctx = await setupTest();
  const tapClient = await ctx.daemon.openClient();
  const tap = await startStubTap(tapClient, ctx.sender, { notices: true });

  const sent = await ctx.inside.sendRequest('session.message', {
    session: ctx.recipient,
    text: 'rename the module',
  });

  await ctx.daemon.sendHookLines({
    atcId: ctx.recipient,
    event: 'Note',
    payload: {
      kind: 'unanswered',
      messages: [sent['message']],
      reason: 'interrupted',
      turn: 't-1',
    },
  });

  await waitFor(() => {
    expect<unknown[]>(tap.notices).toStrictEqual([
      {
        ev: 'InboxNotice',
        sessionID: ctx.sender,
        message: getString(sent, 'message'),
        from: ctx.recipient,
        status: 'unanswered',
        reason: 'interrupted',
        at: expect.any(Number),
      },
    ]);
  });
});

test('it hands the sending session an unanswered notice when the recipient session ends', async () => {
  // The sender runs on; the recipient ends once it reads a line of input.
  const planSpawn = mock(() => ({ bin: 'head', args: ['-n', '1'] })).mockReturnValueOnce({
    bin: 'sleep',
    args: ['30'],
  });

  const ctx = await setupTest(planSpawn);
  const tapClient = await ctx.daemon.openClient();
  const tap = await startStubTap(tapClient, ctx.sender, { notices: true });
  const recipientTap = await ctx.daemon.openClient();

  const sent = await ctx.inside.sendRequest('session.message', {
    session: ctx.recipient,
    text: 'write the release notes',
  });

  await recipientTap.sendRequest('session.tap', { session: ctx.recipient });

  await recipientTap.sendRequest('message.ack', {
    session: ctx.recipient,
    message: sent['message'],
  });

  await ctx.daemon.client.sendRequest('session.input', { session: ctx.recipient, data: 'end\r' });

  await waitFor(() => {
    expect<unknown[]>(tap.notices).toStrictEqual([
      {
        ev: 'InboxNotice',
        sessionID: ctx.sender,
        message: getString(sent, 'message'),
        from: ctx.recipient,
        status: 'unanswered',
        reason: 'session_ended',
        at: expect.any(Number),
      },
    ]);
  });
});

test('it hands the sending session one unanswered notice when the recipient of a queued message is removed', async () => {
  const ctx = await setupTest();
  const tapClient = await ctx.daemon.openClient();
  const tap = await startStubTap(tapClient, ctx.sender, { notices: true });

  const sent = await ctx.inside.sendRequest('session.message', {
    session: ctx.recipient,
    text: 'archive the old logs',
  });

  // The first kill leaves an exited entry, whose next process could still
  // take the message; the second removes it.
  await ctx.daemon.client.sendRequest('session.kill', { session: ctx.recipient });
  await ctx.daemon.client.sendRequest('session.kill', { session: ctx.recipient });

  await waitFor(() => {
    expect<unknown[]>(tap.notices).toStrictEqual([
      {
        ev: 'InboxNotice',
        sessionID: ctx.sender,
        message: getString(sent, 'message'),
        from: ctx.recipient,
        status: 'unanswered',
        reason: 'session_ended',
        at: expect.any(Number),
      },
    ]);
  });

  // A second tap replays nothing the first one took.
  const replayClient = await ctx.daemon.openClient();
  const replay = await startStubTap(replayClient, ctx.sender, { notices: true });

  expect(replay.notices).toStrictEqual([]);
  expect(tap.notices).toHaveLength(1);
});

test('it hands one answer notice for a message whose answer is reported twice', async () => {
  const ctx = await setupTest();
  const tapClient = await ctx.daemon.openClient();
  const tap = await startStubTap(tapClient, ctx.sender, { notices: true });

  const sent = await ctx.inside.sendRequest('session.message', {
    session: ctx.recipient,
    text: 'count the open issues',
  });

  const answer = {
    atcId: ctx.recipient,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'seven' },
  };

  await ctx.daemon.sendHookLines(answer);
  await ctx.daemon.sendHookLines(answer);

  await waitFor(() => {
    expect(tap.notices).toHaveLength(1);
  });

  // A second tap replays nothing the first one took.
  const replayClient = await ctx.daemon.openClient();
  const replay = await startStubTap(replayClient, ctx.sender, { notices: true });
  const read = await ctx.daemon.client.sendRequest('events.read', { session: ctx.sender });

  expect(replay.notices).toStrictEqual([]);

  const events: unknown[] = Array.isArray(read['events']) ? read['events'] : [];

  expect(
    events
      .filter((entry): entry is Readonly<Record<string, unknown>> => isRecord(entry))
      .filter((entry) => typeof entry['kind'] === 'string' && entry['kind'].startsWith('notice-'))
      .map((entry) => [entry['kind'], entry['message']]),
  ).toStrictEqual([
    ['notice-queued', sent['message']],
    ['notice-delivered', sent['message']],
  ]);
});

test('it hands one answer notice after a restart when the daemon stopped right after the answer settled the message', async () => {
  const ctx = await setupTest();

  const sent = await ctx.inside.sendRequest('session.message', {
    session: ctx.recipient,
    text: 'tag the release',
  });

  // An agent session id makes each session revivable after the restart.
  await ctx.daemon.sendHookLines(
    { atcId: ctx.sender, event: 'SessionStart', payload: { session_id: 'agent-sender' } },
    { atcId: ctx.recipient, event: 'SessionStart', payload: { session_id: 'agent-recipient' } },
  );

  await waitFor(async () => {
    const listed = await ctx.daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toIncludeAllPartialMembers([
      { id: ctx.sender, agentSessionID: 'agent-sender' },
      { id: ctx.recipient, agentSessionID: 'agent-recipient' },
    ]);
  });

  await ctx.daemon.stop();

  // The settling statement a daemon commits before it stops, with nothing
  // after it.
  const store = await createStateStore(ctx.daemon.dbPath);

  registerTestCleanup(() => store.stop());

  await store.updateMessagesAnswered(
    [toMessageID(String(sent['message']))],
    { atcID: toSessionID(ctx.recipient) },
    'the release is tagged',
    Date.now(),
  );

  await ctx.daemon.restart();
  await ctx.daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitFor(async () => {
    const listed = await ctx.daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id: ctx.sender, alive: true });
  });

  const tapClient = await ctx.daemon.openClient();
  const tap = await startStubTap(tapClient, ctx.sender, { notices: true });

  await waitFor(() => {
    expect<unknown[]>(tap.notices).toStrictEqual([
      {
        ev: 'InboxNotice',
        sessionID: ctx.sender,
        message: getString(sent, 'message'),
        from: ctx.recipient,
        status: 'answered',
        answer: 'the release is tagged',
        at: expect.any(Number),
      },
    ]);
  });
});

test('it hands no second answer notice when the answer is reported again after a restart', async () => {
  const ctx = await setupTest();

  const sent = await ctx.inside.sendRequest('session.message', {
    session: ctx.recipient,
    text: 'bump the version',
  });

  // An agent session id makes each session revivable after the restart.
  await ctx.daemon.sendHookLines(
    { atcId: ctx.sender, event: 'SessionStart', payload: { session_id: 'agent-sender' } },
    { atcId: ctx.recipient, event: 'SessionStart', payload: { session_id: 'agent-recipient' } },
  );

  await waitFor(async () => {
    const listed = await ctx.daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toIncludeAllPartialMembers([
      { id: ctx.sender, agentSessionID: 'agent-sender' },
      { id: ctx.recipient, agentSessionID: 'agent-recipient' },
    ]);
  });

  await ctx.daemon.stop();

  // The settling statement a daemon commits before it stops, with nothing
  // after it.
  const store = await createStateStore(ctx.daemon.dbPath);

  registerTestCleanup(() => store.stop());

  await store.updateMessagesAnswered(
    [toMessageID(String(sent['message']))],
    { atcID: toSessionID(ctx.recipient) },
    'the version is bumped',
    Date.now(),
  );

  await ctx.daemon.restart();
  await ctx.daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitFor(async () => {
    const listed = await ctx.daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id: ctx.recipient, alive: true });
    expect(listed['sessions']).toPartiallyContain({ id: ctx.sender, alive: true });
  });

  const tapClient = await ctx.daemon.openClient();
  const tap = await startStubTap(tapClient, ctx.sender, { notices: true });

  await waitFor(() => {
    expect(tap.notices).toHaveLength(1);
  });

  await ctx.daemon.sendHookLines({
    atcId: ctx.recipient,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'the version is bumped' },
  });

  await waitFor(() => {
    expect(ctx.noteIgnored).toHaveBeenCalledWith(ctx.recipient, 'answered');
  });

  // A second tap replays nothing the first one took.
  const replayClient = await ctx.daemon.openClient();
  const replay = await startStubTap(replayClient, ctx.sender, { notices: true });

  expect(replay.notices).toStrictEqual([]);
  expect(tap.notices).toHaveLength(1);
});

test('it marks a message delivered before a restart unanswered for its sender and never hands it to the revived recipient', async () => {
  const ctx = await setupTest(undefined, { restoreFleetOnRestart: true });

  // An agent session id makes each session revivable after the restart.
  await ctx.daemon.sendHookLines(
    { atcId: ctx.sender, event: 'SessionStart', payload: { session_id: 'agent-sender' } },
    { atcId: ctx.recipient, event: 'SessionStart', payload: { session_id: 'agent-recipient' } },
  );

  await waitFor(async () => {
    const listed = await ctx.daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toIncludeAllPartialMembers([
      { id: ctx.sender, agentSessionID: 'agent-sender' },
      { id: ctx.recipient, agentSessionID: 'agent-recipient' },
    ]);
  });

  const sent = await ctx.inside.sendRequest('session.message', {
    session: ctx.recipient,
    text: 'rotate the staging keys',
  });

  const beforeClient = await ctx.daemon.openClient();
  const before = await startStubTap(beforeClient, ctx.recipient);

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('message.get', { message: sent['message'] });

    expect(read['status']).toBe('delivered');
  });

  await ctx.daemon.restart();

  await waitFor(async () => {
    const listed = await ctx.daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id: ctx.recipient, alive: true });
    expect(listed['sessions']).toPartiallyContain({ id: ctx.sender, alive: true });
  });

  const afterClient = await ctx.daemon.openClient();
  const after = await startStubTap(afterClient, ctx.recipient);

  // The inbox drains in sent order, so a later message that arrives alone
  // shows the revived tap was handed nothing before it.
  const later = await ctx.daemon.client.sendRequest('session.message', {
    session: ctx.recipient,
    text: 'archive the build logs',
  });

  await waitFor(() => {
    expect<unknown[]>(after.messages).toStrictEqual([
      {
        ev: 'InboxMessage',
        sessionID: ctx.recipient,
        message: getString(later, 'message'),
        from: 'owner',
        sender: { kind: 'owner', name: 'owner' },
        text: 'archive the build logs',
        sentAt: expect.any(Number),
      },
    ]);
  });

  const read = await ctx.daemon.client.sendRequest('message.get', { message: sent['message'] });
  const tapClient = await ctx.daemon.openClient();
  const tap = await startStubTap(tapClient, ctx.sender, { notices: true });

  await waitFor(() => {
    expect<unknown[]>(tap.notices).toStrictEqual([
      {
        ev: 'InboxNotice',
        sessionID: ctx.sender,
        message: getString(sent, 'message'),
        from: ctx.recipient,
        status: 'unanswered',
        reason: 'session_ended',
        at: expect.any(Number),
      },
    ]);
  });

  expect(read).toMatchObject({ status: 'unanswered', unansweredReason: 'session_ended' });
  expect(before.messages).toHaveLength(1);
});

test('it keeps the answer notice of an exited sender queued and hands it over once the sender revives', async () => {
  // The sender ends once it reads a line of input; every later process
  // runs on.
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] })).mockReturnValueOnce({
    bin: 'head',
    args: ['-n', '1'],
  });

  const ctx = await setupTest(planSpawn);

  await ctx.daemon.sendHookLines({
    atcId: ctx.sender,
    event: 'SessionStart',
    payload: { session_id: 'agent-sender' },
  });

  await waitFor(async () => {
    const listed = await ctx.daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({
      id: ctx.sender,
      agentSessionID: 'agent-sender',
    });
  });

  const sent = await ctx.inside.sendRequest('session.message', {
    session: ctx.recipient,
    text: 'review the diff',
  });

  await ctx.daemon.client.sendRequest('session.input', { session: ctx.sender, data: 'end\r' });

  await waitFor(async () => {
    const listed = await ctx.daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id: ctx.sender, alive: false });
  });

  await ctx.daemon.sendHookLines({
    atcId: ctx.recipient,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'the diff looks fine' },
  });

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('events.read', { session: ctx.sender });

    expect(read['events']).toPartiallyContain({ kind: 'notice-queued', message: sent['message'] });
  });

  await ctx.daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitFor(async () => {
    const listed = await ctx.daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toPartiallyContain({ id: ctx.sender, alive: true });
  });

  const tapClient = await ctx.daemon.openClient();
  const tap = await startStubTap(tapClient, ctx.sender, { notices: true });

  await waitFor(() => {
    expect(tap.notices).toPartiallyContain({
      message: sent['message'],
      status: 'answered',
      answer: 'the diff looks fine',
    });
  });
});

test('it hands no answer notice for a message whose from names the session but whose caller runs in none', async () => {
  const ctx = await setupTest();
  const tapClient = await ctx.daemon.openClient();
  const tap = await startStubTap(tapClient, ctx.sender, { notices: true });

  const sent = await ctx.daemon.client.sendRequest('session.message', {
    session: ctx.recipient,
    text: 'check the logs',
    from: ctx.sender,
  });

  await ctx.daemon.sendHookLines({
    atcId: ctx.recipient,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'the logs are clean' },
  });

  await waitFor(() => {
    expect(ctx.daemon.events).toPartiallyContain({
      ev: 'SessionMessage',
      message: sent['message'],
      status: 'answered',
    });
  });

  const read = await ctx.daemon.client.sendRequest('events.read', { session: ctx.sender });

  expect<unknown[]>(tap.notices).toStrictEqual([]);
  expect(read['events']).not.toPartiallyContain({ kind: 'notice-queued' });
});

test('it hands no answer notice to a tap that did not ask for notices', async () => {
  const ctx = await setupTest();
  const tapClient = await ctx.daemon.openClient();
  const tap = await startStubTap(tapClient, ctx.sender);

  const events: DaemonEvent[] = [];

  const watcher = await ctx.daemon.openClient();

  watcher.onEvent = (event) => {
    events.push(event);
  };

  const sent = await ctx.inside.sendRequest('session.message', {
    session: ctx.recipient,
    text: 'tag the release',
  });

  await ctx.daemon.sendHookLines({
    atcId: ctx.recipient,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'tagged' },
  });

  await waitFor(async () => {
    const read = await ctx.daemon.client.sendRequest('events.read', { session: ctx.sender });

    expect(read['events']).toPartiallyContain({ kind: 'notice-queued', message: sent['message'] });
  });

  expect<unknown[]>(tap.notices).toStrictEqual([]);
  expect(events.filter((daemonEvent) => daemonEvent.ev === 'InboxNotice')).toStrictEqual([]);
});

test('it hands no answer notice to the sending session for a message sent with notice false', async () => {
  const ctx = await setupTest();
  const tapClient = await ctx.daemon.openClient();
  const tap = await startStubTap(tapClient, ctx.sender, { notices: true });

  const sent = await ctx.inside.sendRequest('session.message', {
    session: ctx.recipient,
    text: 'the nightly sweep found two stale branches',
    notice: false,
  });

  await ctx.daemon.sendHookLines({
    atcId: ctx.recipient,
    event: 'Note',
    payload: { kind: 'answered', message: sent['message'], answer: 'noted' },
  });

  await waitFor(() => {
    expect(ctx.daemon.events).toPartiallyContain({
      ev: 'SessionMessage',
      message: sent['message'],
      status: 'answered',
    });
  });

  const read = await ctx.daemon.client.sendRequest('events.read', { session: ctx.sender });
  const message = await ctx.inside.sendRequest('message.get', { message: sent['message'] });

  expect<unknown[]>(tap.notices).toStrictEqual([]);
  expect(read['events']).not.toPartiallyContain({ kind: 'notice-queued' });
  expect([message['status'], message['answer']]).toStrictEqual(['answered', 'noted']);
});
