import { expect, test } from 'bun:test';
import { decodeCursor } from '../protocol/decode-cursor';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { buildFleetEvents } from './build-fleet-events';

test('it names an event by the live session holding its agent session id', () => {
  const events = buildFleetEvents(
    [
      {
        id: 1,
        at: 1000,
        atcID: toSessionID('s-old'),
        agentSessionID: toAgentSessionID('c1'),
        kind: 'turn-done',
        detail: null,
      },
    ],
    [
      {
        id: toSessionID('s-new'),
        name: 'worker',
        cwd: '/tmp',
        state: 'done',
        unread: false,
        lastMsg: 'turn done',
        agentSessionID: toAgentSessionID('c1'),
        agent: 'claude',
        pinned: false,
        lastAttachedAt: 1,
        repoRoot: '/tmp',
        namedBy: 'user',
        createdAt: 1,
        kind: 'pty',
        alive: true,
        canEject: false,
      },
    ],
  );

  expect(events).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: 1000,
      session: 's-new',
      name: 'worker',
      kind: 'turn-done',
      detail: null,
    },
  ]);
});

test('it names an event by atc id when it carries no agent session id', () => {
  const events = buildFleetEvents(
    [
      {
        id: 1,
        at: 1000,
        atcID: toSessionID('s1'),
        agentSessionID: null,
        kind: 'started',
        detail: null,
      },
    ],
    [
      {
        id: toSessionID('s1'),
        name: 'worker',
        cwd: '/tmp',
        state: 'running',
        unread: false,
        lastMsg: 'started',
        agent: 'claude',
        pinned: false,
        lastAttachedAt: 1,
        repoRoot: '/tmp',
        namedBy: 'user',
        createdAt: 1,
        kind: 'pty',
        alive: true,
        canEject: false,
      },
    ],
  );

  expect(events).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: 1000,
      session: 's1',
      name: 'worker',
      kind: 'started',
      detail: null,
    },
  ]);
});

test('it keeps the stored atc id and no name when no live session matches', () => {
  const events = buildFleetEvents(
    [
      {
        id: 1,
        at: 1000,
        atcID: toSessionID('s-gone'),
        agentSessionID: toAgentSessionID('c9'),
        kind: 'ended',
        detail: 'bye',
      },
    ],
    [],
  );

  expect(events).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: 1000,
      session: 's-gone',
      name: null,
      kind: 'ended',
      detail: 'bye',
    },
  ]);
});

test('it gives each event a cursor that decodes to its id', () => {
  const [event] = buildFleetEvents(
    [
      {
        id: 7,
        at: 1000,
        atcID: toSessionID('s1'),
        agentSessionID: null,
        kind: 'started',
        detail: null,
      },
    ],
    [],
  );

  if (event === undefined) {
    throw new Error('expected an event');
  }

  expect(decodeCursor(event.cursor)).toStrictEqual({ kind: 'events', id: 7 });
});

test('it carries the message id on a message event', () => {
  const events = buildFleetEvents(
    [
      {
        id: 1,
        at: 1000,
        atcID: toSessionID('s1'),
        agentSessionID: null,
        kind: 'message-delivered',
        detail: 'hello',
        message: toMessageID('m-1'),
      },
    ],
    [],
  );

  expect(events).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: 1000,
      session: 's1',
      name: null,
      kind: 'message-delivered',
      detail: 'hello',
      message: toMessageID('m-1'),
    },
  ]);
});

test('it carries the label on a report event', () => {
  const events = buildFleetEvents(
    [
      {
        id: 1,
        at: 1000,
        atcID: toSessionID('s1'),
        agentSessionID: null,
        kind: 'report',
        detail: 'need review',
        label: 'blocked',
      },
    ],
    [],
  );

  expect(events).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: 1000,
      session: 's1',
      name: null,
      kind: 'report',
      detail: 'need review',
      label: 'blocked',
    },
  ]);
});
