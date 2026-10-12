/**
 * The access a remote MCP client can be granted, one scope per kind of tool:
 * reading the fleet, messaging a session, spawning or typing into one, and
 * killing one.
 */
export const GRANT_SCOPES = ['read', 'message', 'spawn', 'kill'] as const;

export type GrantScope = (typeof GRANT_SCOPES)[number];
