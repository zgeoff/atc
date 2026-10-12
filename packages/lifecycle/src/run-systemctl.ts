import { runCommand } from './run-command';

/**
 * Runs `systemctl --user` with `args` and returns its exit code and output.
 * A machine without systemctl reads as exit code 127.
 */
export function runSystemctl(args: readonly string[]): ReturnType<typeof runCommand> {
  return runCommand(['systemctl', '--user', ...args]);
}
