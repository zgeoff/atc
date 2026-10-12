import type { Paths } from '@atc/config/resolve-paths';
import type { Clock } from '@atc/core/system-clock';
import type { ATCInvocation } from './atc-invocation';
import type { CommandResult } from './run-command';

/**
 * What the daemon's process control reaches outside its own code, which the
 * entry builds from its environment: the invocation that starts a daemon or
 * a restart worker and reads this build's stamp, the state and socket
 * paths, the clock every wait runs on, the directory read as `/proc`, the
 * time a fleet restore gives one revived session to boot, the lookup of an
 * installed daemon user unit, which makes a client wait for the daemon
 * instead of starting one, and the user service manager's `systemctl`.
 */
export interface LifecycleHost {
  readonly invocation: ATCInvocation;
  readonly paths: Paths;
  readonly clock: Clock;
  readonly procRoot: string;
  readonly restoreBootTimeoutMs: number;
  readonly findManagedUnit: () => string | null;
  readonly runSystemctl: (args: readonly string[]) => Promise<CommandResult>;
}
