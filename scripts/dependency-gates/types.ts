export interface DependencyGateFinding {
  // The repo file that holds the entry, relative to the repo root.
  readonly path: string;

  readonly entry: string;
  readonly problem: string;
}

export interface LockfileDependent {
  readonly dependent: string;
  readonly name: string;
  readonly range: string;
}

// An ignore names an advisory by its GHSA ID or by bun's numeric ID, so an advisory carries both.
export interface AuditAdvisory {
  readonly advisoryIDs: readonly string[];
  readonly packageName: string;
}
