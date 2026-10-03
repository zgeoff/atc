import { buildCLIArgv } from './build-cli-argv';

/**
 * Command line that wrangled sessions invoke for atc subcommands: under bun
 * the CLI entry path is part of the command; a compiled binary is itself
 * the entry. A session on a remote host passes the argv of the atc inside
 * that host.
 */
export function buildCLICommand(
  subcommand: string,
  argv: readonly string[] = buildCLIArgv(),
): string {
  return `${argv.map((part) => `"${part}"`).join(' ')} ${subcommand}`;
}
