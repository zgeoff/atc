export function buildATCCommand(atcArgv: readonly string[], args: readonly string[]): string[] {
  return [...atcArgv, ...args];
}
