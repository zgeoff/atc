export type WorkspaceSource =
  | { readonly kind: 'path'; readonly host: string; readonly path: string }
  | {
      readonly kind: 'git';
      readonly url: string;
      readonly ref: string;

      // The commit to check out when the ref only names its branch.
      readonly sha?: string;
    };
