// the target still lists, and refuses every spawn.
export class TargetUnavailableError extends Error {
  readonly problem: string | null;

  constructor(target: string, problem: string | null) {
    super(problem ?? `target ${JSON.stringify(target)} has no provider configured`);

    this.name = 'TargetUnavailableError';
    this.problem = problem;
  }
}
