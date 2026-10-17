export interface SessionChanges {
  readonly name?: string;
  readonly pinned?: boolean;

  // null makes a sub-session top-level; an absent field keeps what the
  // session holds
  readonly parent?: null;
}
