import { join } from 'node:path';
import { isCompiledBinary } from '../shared/is-compiled-binary';

/**
 * The argv that runs the atc CLI from inside a wrangled session: under bun
 * the CLI entry path follows the runtime; a compiled binary is itself the
 * entry.
 */
export function buildCLIArgv(): string[] {
  return isCompiledBinary()
    ? [process.execPath]
    : [process.execPath, join(import.meta.dir, '..', 'cli.ts')];
}
