/**
 * The argv that runs this build of atc with `args`: the argv that starts the
 * CLI, then the arguments.
 */
export function buildATCCommand(atcArgv: readonly string[], args: readonly string[]): string[] {
  return [...atcArgv, ...args];
}
