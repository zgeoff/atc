/**
 * Thrown by an execution plugin's factory for a target it serves no
 * provider for. The target still lists and refuses every spawn. `problem`
 * holds what keeps the target from a provider, or null when its config
 * leaves it unconfigured on purpose.
 */
export class TargetUnavailableError extends Error {
  readonly problem: string | null;

  constructor(target: string, problem: string | null) {
    super(problem ?? `target ${JSON.stringify(target)} has no provider configured`);

    this.name = 'TargetUnavailableError';
    this.problem = problem;
  }
}
