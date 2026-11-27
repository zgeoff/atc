// A workspace package, by its folder from the repo root, with the names of the workspace packages
// it depends on at run time.
export interface WorkspacePackage {
  readonly folder: string;
  readonly name: string;
  readonly workspaceDependencies: readonly string[];
}
