import { expect, test } from 'bun:test';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toMessageID } from '../shared/to-message-id';
import { buildMockMessageRecord } from './build-mock-message-record';

test('it builds a default message record', () => {
  expect(buildMockMessageRecord()).toStrictEqual({
    id: expect.toBeString(),
    atcID: expect.toBeString(),
    from: expect.toBeString(),
    text: expect.toBeString(),
    status: 'accepted',
    sentAt: expect.toBeNumber(),
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockMessageRecord({
      id: toMessageID('m-1'),
      agentSessionID: toAgentSessionID('a1'),
      status: 'answered',
      answer: 'done',
    }),
  ).toStrictEqual({
    id: toMessageID('m-1'),
    atcID: expect.toBeString(),
    from: expect.toBeString(),
    text: expect.toBeString(),
    status: 'answered',
    sentAt: expect.toBeNumber(),
    agentSessionID: toAgentSessionID('a1'),
    answer: 'done',
  });
});
