/**
 * Where a session's workspace comes from: a directory on a host, which is
 * resolved to a pushed commit before anything leaves that host, or a git
 * repository and ref, optionally pinned to a commit, that the control side
 * clones itself.
 */
export type WorkspaceSource =
  | { readonly kind: 'path'; readonly host: string; readonly path: string }
  | {
      readonly kind: 'git';
      readonly url: string;
      readonly ref: string;

      // The commit to check out when the ref only names its branch.
      readonly sha?: string;
    };
