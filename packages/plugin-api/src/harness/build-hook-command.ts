export function buildHookCommand(subcommand: string, atcArgv: readonly string[]): string {
  return `${atcArgv.map((part) => `"${part}"`).join(' ')} ${subcommand}`;
}
