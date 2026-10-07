import { expectTypeOf, test } from 'bun:test';
import type { AgentSessionID } from './agent-session-id';
import type { SessionID } from './session-id';

test('it refuses an agent-minted session id where an atc session id is expected', () => {
  expectTypeOf<AgentSessionID>().not.toExtend<SessionID>();
});

test('it refuses an atc session id where an agent-minted session id is expected', () => {
  expectTypeOf<SessionID>().not.toExtend<AgentSessionID>();
});
