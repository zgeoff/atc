import { join } from 'node:path';
import { isCompiledBinary } from '../shared/is-compiled-binary';

/**
 * Command line that wrangled sessions invoke for atc subcommands: under bun
 * the CLI entry path is part of the command; a compiled binary is itself
 * the entry.
 */
export function buildCLICommand(subcommand: string): string {
  const exec = process.execPath;

  if (isCompiledBinary()) {
    return `"${exec}" ${subcommand}`;
  }

  return `"${exec}" "${join(import.meta.dir, '..', 'cli.ts')}" ${subcommand}`;
}
