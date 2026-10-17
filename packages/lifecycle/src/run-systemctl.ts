import { runCommand } from './run-command/run-command';

export function runSystemctl(args: readonly string[]): ReturnType<typeof runCommand> {
  return runCommand(['systemctl', '--user', ...args]);
}
