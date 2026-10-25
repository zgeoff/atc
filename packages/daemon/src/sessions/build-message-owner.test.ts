import { expect, test } from 'bun:test';
import { toAgentSessionID, toSessionID } from '@atcx/contract';
import { buildMockSession } from '../testing/build-mock-session';
import { buildMessageOwner } from './build-message-owner';

test('it owns the messages of a session by its atc id and agent session id', () => {
  const session = buildMockSession({
    id: toSessionID('s-1'),
    agentSessionID: toAgentSessionID('a-1'),
  });

  expect(buildMessageOwner(session)).toStrictEqual({
    atcID: toSessionID('s-1'),
    agentSessionID: toAgentSessionID('a-1'),
  });
});

test('it owns the messages of a session with no agent session id by its atc id alone', () => {
  const session = buildMockSession({ id: toSessionID('s-1') });

  expect(buildMessageOwner(session)).toStrictEqual({ atcID: toSessionID('s-1') });
});
