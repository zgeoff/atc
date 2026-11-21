import type { Clock } from '@zgeoff/std';

export interface HostServices {
  readonly atcArgv: readonly string[];

  readonly version: string;

  readonly build: string;

  readonly runCommand: (
    argv: readonly string[],
    options?: HostCommandOptions,
  ) => Promise<HostCommandResult>;
  readonly clock: Pick<Clock, 'now' | 'schedule'>;

  readonly log: (line: string) => void;
}

export interface ExecutionHostServices extends HostServices {
  readonly stateDir: string;
}

export interface HostCommandOptions {
  readonly env?: Readonly<Record<string, string>>;

  readonly signal?: Readonly<AbortSignal>;
}

export interface HostCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
}
