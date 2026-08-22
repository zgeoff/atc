import type { Tagged } from 'type-fest';

/**
 * The atc-generated session id, minted by the session manager when it spawns
 * or restores a session. It keys every protocol method, every daemon-side
 * per-session map, and the hook envelope's `atcId` field.
 */
export type SessionID = Tagged<string, 'SessionID'>;
