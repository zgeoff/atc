import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { decodeCursor } from '../protocol/decode-cursor';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { buildMockSessionDescriptor } from '../test-utils/build-mock-session-descriptor';
import { buildMockStoredEvent } from '../test-utils/build-mock-stored-event';
import { buildFleetEvents } from './build-fleet-events';

test('it names an event by the live session holding its agent session id', () => {
  const events = buildFleetEvents(
    [
      buildMockStoredEvent({
        at: 1000,
        atcID: toSessionID('s-old'),
        agentSessionID: toAgentSessionID('c1'),
        kind: 'turn-done',
        detail: null,
      }),
    ],
    [
      buildMockSessionDescriptor({
        id: toSessionID('s-new'),
        name: 'worker',
        agentSessionID: toAgentSessionID('c1'),
      }),
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
      buildMockStoredEvent({
        at: 1000,
        atcID: toSessionID('s1'),
        agentSessionID: null,
        kind: 'started',
        detail: null,
      }),
    ],
    [
      buildMockSessionDescriptor({
        id: toSessionID('s1'),
        name: 'worker',
      }),
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
      buildMockStoredEvent({
        at: 1000,
        atcID: toSessionID('s-gone'),
        agentSessionID: toAgentSessionID('c9'),
        kind: 'ended',
        detail: 'bye',
      }),
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
  const [event] = buildFleetEvents([buildMockStoredEvent({ id: 7 })], []);

  invariant(event !== undefined, 'expected an event');

  expect(decodeCursor(event.cursor)).toStrictEqual({ kind: 'events', id: 7 });
});

test('it carries the message id on a message event', () => {
  const events = buildFleetEvents(
    [
      buildMockStoredEvent({
        at: 1000,
        atcID: toSessionID('s1'),
        agentSessionID: null,
        kind: 'message-delivered',
        detail: 'hello',
        message: toMessageID('m-1'),
      }),
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
      buildMockStoredEvent({
        at: 1000,
        atcID: toSessionID('s1'),
        agentSessionID: null,
        kind: 'report',
        detail: 'need review',
        label: 'blocked',
      }),
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

test('it names an event by the session holding its atc id ahead of one sharing its agent session id', () => {
  const events = buildFleetEvents(
    [
      buildMockStoredEvent({
        at: 1000,
        atcID: toSessionID('s-own'),
        agentSessionID: toAgentSessionID('c1'),
        kind: 'turn-done',
        detail: null,
      }),
    ],
    [
      buildMockSessionDescriptor({
        id: toSessionID('s-other'),
        name: 'other',
        agentSessionID: toAgentSessionID('c1'),
      }),
      buildMockSessionDescriptor({
        id: toSessionID('s-own'),
        name: 'own',
        agentSessionID: toAgentSessionID('c1'),
      }),
    ],
  );

  expect(events).toStrictEqual([
    {
      cursor: expect.toBeString(),
      at: 1000,
      session: 's-own',
      name: 'own',
      kind: 'turn-done',
      detail: null,
    },
  ]);
});

test('it keeps an event on its own atc id when it may take no alias', () => {
  const [event] = buildFleetEvents(
    [
      buildMockStoredEvent({
        at: 1000,
        atcID: toSessionID('s-hidden'),
        agentSessionID: toAgentSessionID('c1'),
        kind: 'turn-done',
        detail: null,
      }),
    ],
    [
      buildMockSessionDescriptor({
        id: toSessionID('s-shown'),
        name: 'worker',
        agentSessionID: toAgentSessionID('c1'),
      }),
    ],
    [],
  );

  expect(event).toStrictEqual({
    cursor: expect.toBeString(),
    at: 1000,
    session: 's-hidden',
    name: null,
    kind: 'turn-done',
    detail: null,
  });
});
