import type { Tagged } from 'type-fest';

/**
 * The session id an agent CLI issues for its own resume mechanism — what
 * `claude --resume <id>` takes. Adapters mint it from a hook payload or a
 * stored fleet row, and the fleet table keys on it.
 */
export type AgentSessionID = Tagged<string, 'AgentSessionID'>;
