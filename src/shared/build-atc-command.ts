import { join } from 'node:path';
import { isCompiledBinary } from './is-compiled-binary';

/**
 * The argv that runs this build of atc with `args`: the compiled binary is
 * its own entry, and a source run is bun with the CLI entrypoint ahead of
 * the arguments.
 */
export function buildATCCommand(args: readonly string[]): string[] {
  return isCompiledBinary()
    ? [process.execPath, ...args]
    : [process.execPath, join(import.meta.dir, '..', 'cli.ts'), ...args];
}
