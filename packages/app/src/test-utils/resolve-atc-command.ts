import { join } from 'node:path';

/**
 * The command an end-to-end suite runs atc as: the compiled binary that
 * `ATC_BIN` holds when a smoke run sets it, or else the source entry under
 * the test's own bun, so one suite proves both. Read at each call, so a test
 * that sets the variable sees its own value.
 */
export function resolveATCCommand(): string[] {
  const bin = process.env['ATC_BIN'];

  return bin === undefined ? [process.execPath, join(import.meta.dir, '..', 'cli.ts')] : [bin];
}
