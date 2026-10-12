import type { DaemonBoot } from '@atc/protocol/daemon-boot';
import type { DaemonBootOptions } from '@atc/protocol/daemon-boot-options';

/**
 * What the TUI reaches outside its own process, which the entry wires in:
 * booting or finding the daemon, taking the daemon behind a socket out of
 * service for a restart, which resolves false when no pid for it is found,
 * and the log of decisions the client takes without drawing anything.
 */
export interface TUIHost {
  readonly bootDaemon: (options?: DaemonBootOptions) => Promise<DaemonBoot>;
  readonly restartDaemon: (socketPath: string) => Promise<boolean>;
  readonly logEvent: (line: string) => void;
}
