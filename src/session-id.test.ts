import { expect, test } from 'bun:test';
import type { AgentSessionID } from './agent-session-id';
import { PermissionRegistry } from './permission-registry';
import type { SessionID } from './session-id';

// Its only job is compile-time constraint of its argument: a call that
// typechecks here proves the branded id it was called with is a SessionID,
// never an AgentSessionID wearing the same underlying string.
function defineSessionID(id: SessionID): SessionID {
  return id;
}

function defineAgentSessionID(id: AgentSessionID): AgentSessionID {
  return id;
}

test('it rejects an AgentSessionID where a SessionID is required, and the reverse', () => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- stand-in values to exercise the two branded types against each other
  const sessionID = 's1' as SessionID;

  // oxlint-disable-next-line no-unsafe-type-assertion -- stand-in values to exercise the two branded types against each other
  const agentSessionID = 'a1' as AgentSessionID;

  // @ts-expect-error -- an agent-minted session id is not an atc session id
  defineSessionID(agentSessionID);

  // @ts-expect-error -- an atc session id is not an agent-minted session id
  defineAgentSessionID(sessionID);
});

test('it rejects an AgentSessionID passed as a PermissionRegistry sessionID', () => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- stand-in value to exercise the two branded types against each other
  const agentSessionID = 'a1' as AgentSessionID;

  const registry = new PermissionRegistry();

  // Respondable, so the answer below resolves the request and clears the
  // registry's pending timeout rather than leaving it running past the test.
  // @ts-expect-error -- an agent-minted session id is not an atc session id
  const req = registry.open(agentSessionID, 'needs permission', true);

  expect(registry.answer(req.id, 'dismissed')).toBe('ok');
});
