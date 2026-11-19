import type { Paths } from '@atc/config/host';
import type { Clock } from '@atc/core';
import type { CommandResult } from '../run-command/run-command';
import type { tryOpenDaemon } from './try-open-daemon';

export interface LifecycleHost {
  readonly invocation: ATCInvocation;
  readonly paths: Paths;
  readonly clock: Clock;
  readonly procRoot: string;
  readonly restoreBootTimeoutMs: number;
  readonly findManagedUnit: () => string | null;
  readonly runSystemctl: (args: readonly string[]) => Promise<CommandResult>;
  readonly openDaemon: typeof tryOpenDaemon;
}

export interface ATCInvocation {
  readonly argv: readonly string[];

  readonly readBuild: () => string;
}
