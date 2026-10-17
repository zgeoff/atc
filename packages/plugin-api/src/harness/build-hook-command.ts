// a session on a remote host passes the argv of the atc inside that host.
export function buildHookCommand(subcommand: string, atcArgv: readonly string[]): string {
  return `${atcArgv.map((part) => `"${part}"`).join(' ')} ${subcommand}`;
}
