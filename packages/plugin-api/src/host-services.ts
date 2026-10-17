import type { Clock } from '@atc/core';

// a plugin reaches the running atc, the machine's commands, time, and the log
// only through these, so it holds no path to atc's own source and starts no
// process of its own choosing.
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

export interface HostCommandOptions {
  // set over the daemon's own environment.
  readonly env?: Readonly<Record<string, string>>;

  // an abort kills the command's whole process group, so nothing the command
  // started outlives it.
  readonly signal?: Readonly<AbortSignal>;
}

// output is trimmed. An aborted command has exit code -1 and no output.
export interface HostCommandResult {
  // 127 for a command that could not start.
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
}
