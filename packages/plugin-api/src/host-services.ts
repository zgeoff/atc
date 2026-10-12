import type { Clock } from '@atc/core/system-clock';

/**
 * What atc's host gives every plugin it creates, built once by the
 * process that loads the plugins. A plugin reaches the running atc, the
 * machine's commands, time, and the log only through these, so a plugin
 * holds no path to atc's own source and starts no process of its own
 * choosing.
 */
export interface HostServices {
  // The argv that runs this atc's CLI: the compiled binary alone, or the
  // runtime with the CLI entry.
  readonly atcArgv: readonly string[];

  // This atc's release version.
  readonly version: string;

  // This atc's build identity: the version stamped with the newest source
  // file of a checkout, or with the compiled binary.
  readonly build: string;

  // Runs a command on the daemon's machine with no input, to its exit or
  // until the options' signal aborts.
  readonly runCommand: (
    argv: readonly string[],
    options?: HostCommandOptions,
  ) => Promise<HostCommandResult>;
  readonly clock: Clock;

  // Writes one line to the daemon's log.
  readonly log: (line: string) => void;
}

/**
 * How a command runs: the variables it gets over the daemon's own
 * environment, and a signal whose abort kills the command's whole process
 * group, so nothing the command started outlives it.
 */
export interface HostCommandOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/**
 * How a command ended: its exit code, which is 127 for a command that
 * could not start, and its output, each trimmed. An aborted command has
 * exit code -1 and no output.
 */
export interface HostCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
}
