import type { ChecksProfile } from './read-checks-profile.ts';

export interface WorkflowContext {
  readonly path: string;
  readonly profile: ChecksProfile | undefined;
  readonly workflow: unknown;
  readonly lines: readonly string[];
  readonly jobs: readonly Job[];
  readonly triggers: ReadonlySet<string>;
}

export interface Job {
  readonly id: string;
  readonly definition: unknown;
  readonly line: number;
}

export interface WorkflowFinding {
  // Relative to the repo root.
  readonly path: string;

  readonly line: number;
  readonly message: string;
}
