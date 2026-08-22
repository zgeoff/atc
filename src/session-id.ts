import type { Tagged } from 'type-fest';

/**
 * The atc-generated session id, minted by `SessionManager.spawn` and
 * `SessionManager.restore`. It keys every protocol method, every
 * daemon-side per-session map, and the hook envelope's `atcId` field.
 */
export type SessionID = Tagged<string, 'SessionID'>;
