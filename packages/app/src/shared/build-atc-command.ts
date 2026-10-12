import { join } from 'node:path';
import { isCompiledBinary } from './is-compiled-binary';

/**
 * The argv that runs this build of atc with `args`: the compiled binary is
 * its own entry, and a source run is bun with the CLI entrypoint ahead of
 * the arguments. `compiled` tells the two apart, and defaults to how this
 * process runs.
 */
export function buildATCCommand(
  args: readonly string[],
  compiled: boolean = isCompiledBinary(),
): string[] {
  return compiled
    ? [process.execPath, ...args]
    : [process.execPath, join(import.meta.dir, '..', 'cli.ts'), ...args];
}
