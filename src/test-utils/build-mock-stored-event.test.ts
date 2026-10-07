import { expect, test } from 'bun:test';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toMessageID } from '../shared/to-message-id';
import { buildMockStoredEvent } from './build-mock-stored-event';

test('it builds a default stored event', () => {
  expect(buildMockStoredEvent()).toStrictEqual({
    id: expect.toBeNumber(),
    at: expect.toBeNumber(),
    atcID: expect.toBeString(),
    agentSessionID: null,
    kind: 'turn-done',
    detail: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockStoredEvent({
      id: 7,
      agentSessionID: toAgentSessionID('c1'),
      kind: 'message-delivered',
      message: toMessageID('m-1'),
    }),
  ).toStrictEqual({
    id: 7,
    at: expect.toBeNumber(),
    atcID: expect.toBeString(),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'message-delivered',
    detail: null,
    message: toMessageID('m-1'),
  });
});
