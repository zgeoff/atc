export type WorkspaceSource =
  | { readonly kind: 'path'; readonly host: string; readonly path: string }
  | {
      readonly kind: 'git';
      readonly url: string;
      readonly ref: string;

      readonly sha?: string;
    };
