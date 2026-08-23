import { basename, join } from 'node:path';

/**
 * Command line that wrangled sessions invoke for atc subcommands: under bun
 * the CLI entry path is part of the command; a compiled binary is itself
 * the entry.
 */
export function buildCLICommand(subcommand: string): string {
  const exec = process.execPath;

  if (basename(exec) === 'bun' || basename(exec) === 'bun.exe') {
    return `"${exec}" "${join(import.meta.dir, '..', 'cli.ts')}" ${subcommand}`;
  }

  return `"${exec}" ${subcommand}`;
}
