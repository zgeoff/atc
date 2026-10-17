import { spawn as spawnChild } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { buildATCCommand } from './build-atc-command';

interface SpawnATCDetachedOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly stdio?: StdioOptions;
}

// a session of its own lets the child outlive the caller.
export function spawnATCDetached(
  atcArgv: readonly string[],
  args: readonly string[],

  options: SpawnATCDetachedOptions = {},
): ChildProcess {
  const [bin = process.execPath, ...rest] = buildATCCommand(atcArgv, args);

  const child = spawnChild(bin, rest, {
    detached: true,
    stdio: options.stdio ?? 'ignore',
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

  child.unref();

  return child;
}
