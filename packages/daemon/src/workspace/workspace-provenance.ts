/**
 * What a materialized workspace was built from: the token-free repository
 * URL and the exact commit checked out, plus the image and harness version
 * when the execution target reports them.
 */
export interface WorkspaceProvenance {
  readonly repoURL: string;
  readonly sha: string;
  readonly image?: string;
  readonly harnessVersion?: string;
}
