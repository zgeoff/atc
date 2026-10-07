import { spawn as spawnChild } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { buildATCCommand } from './build-atc-command';

interface SpawnATCDetachedOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly stdio?: StdioOptions;
}

/**
 * Starts this build of atc with `args` in a session of its own, so it
 * outlives the caller, and releases the handle so the caller can exit. The
 * child's stdio is discarded unless `options` routes it elsewhere.
 */
export function spawnATCDetached(
  args: readonly string[],

  // oxlint-disable-next-line prefer-readonly-parameter-types -- the stdio option takes a mutable array
  options: SpawnATCDetachedOptions = {},
): ChildProcess {
  const [bin = process.execPath, ...rest] = buildATCCommand(args);

  const child = spawnChild(bin, rest, {
    detached: true,
    stdio: options.stdio ?? 'ignore',
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

  child.unref();

  return child;
}
