export interface WorkspaceProvenance {
  readonly repoURL: string;
  readonly sha: string;
  readonly image?: string;
  readonly harnessVersion?: string;
}
