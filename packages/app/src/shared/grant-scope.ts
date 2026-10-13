/**
 * The access a remote MCP client can be granted, one scope per kind of tool:
 * `read` reads the fleet; `message` instructs a session's agent, and also
 * renames, pins, detaches and marks a session read; `spawn` starts a session,
 * types into one, or widens what one may touch; `kill` stops or forgets one.
 */
export const GRANT_SCOPES = ['read', 'message', 'spawn', 'kill'] as const;

export type GrantScope = (typeof GRANT_SCOPES)[number];
