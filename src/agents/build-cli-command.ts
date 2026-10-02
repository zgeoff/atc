import { buildCLIArgv } from './build-cli-argv';

/**
 * Command line that wrangled sessions invoke for atc subcommands: under bun
 * the CLI entry path is part of the command; a compiled binary is itself
 * the entry.
 */
export function buildCLICommand(subcommand: string): string {
  return `${buildCLIArgv()
    .map((part) => `"${part}"`)
    .join(' ')} ${subcommand}`;
}
