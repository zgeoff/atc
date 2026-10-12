import { basename } from 'node:path';

/**
 * Whether a command line starts the atc daemon: the atc entry (the `atc`
 * shim or a compiled `atc` binary as the program, or the CLI source file as
 * the runtime's script) directly followed by the `daemon` subcommand, and
 * then nothing, a flag, or `serve`. Any other program that merely passes a
 * `daemon` argument is not the daemon.
 */
export function isDaemonCommandLine(args: readonly string[]): boolean {
  const at = args.indexOf('daemon');

  if (at !== 1 && at !== 2) {
    return false;
  }

  const entry = args[at - 1] ?? '';
  const next = args[at + 1];

  return isATCEntry(entry, at) && (next === undefined || next === 'serve' || next.startsWith('--'));
}

// The program itself when it sits first, or the script a runtime loads when
// it sits second.
function isATCEntry(entry: string, at: number): boolean {
  const name = basename(entry);

  if (at === 1 && /^atc(?:-[a-z0-9]+)*$/.test(name)) {
    return true;
  }

  return at === 2 && (entry.endsWith('/src/cli.ts') || entry.endsWith('/bin/atc'));
}
