/**
 * The command line a wrangled session runs for an atc subcommand, such as
 * its hook reporter: each part of the atc argv quoted, then the
 * subcommand. A session on a remote host passes the argv of the atc inside
 * that host.
 */
export function buildHookCommand(subcommand: string, atcArgv: readonly string[]): string {
  return `${atcArgv.map((part) => `"${part}"`).join(' ')} ${subcommand}`;
}
