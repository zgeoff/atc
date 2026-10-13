/**
 * The changes a caller asks of a session in one update: a new name, a pin
 * or unpin, and a null parent that makes a sub-session top-level. An absent
 * field keeps what the session holds.
 */
export interface SessionChanges {
  readonly name?: string;
  readonly pinned?: boolean;
  readonly parent?: null;
}
