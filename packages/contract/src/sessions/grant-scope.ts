export const GRANT_SCOPES = ['read', 'message', 'spawn', 'kill'] as const;

export type GrantScope = (typeof GRANT_SCOPES)[number];
