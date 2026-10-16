import { expect, test } from 'bun:test';
import { toAgentSessionID, toSessionID } from '@atc/core';
import { buildMockSession } from '../test-utils/build-mock-session';
import { buildMessageOwner } from './build-message-owner';

test('it owns the messages of a session by its atc id and agent session id', () => {
  const s = buildMockSession({
    id: toSessionID('s-1'),
    agentSessionID: toAgentSessionID('a-1'),
  });

  expect(buildMessageOwner(s)).toStrictEqual({
    atcID: toSessionID('s-1'),
    agentSessionID: toAgentSessionID('a-1'),
  });
});

test('it owns the messages of a session with no agent session id by its atc id alone', () => {
  const s = buildMockSession({ id: toSessionID('s-1') });

  expect(buildMessageOwner(s)).toStrictEqual({ atcID: toSessionID('s-1') });
});
