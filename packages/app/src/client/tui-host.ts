import type { DaemonBoot } from '@atc/protocol/daemon-boot';
import type { DaemonBootOptions } from '@atc/protocol/daemon-boot-options';

/**
 * What the TUI reaches outside its own process, which the entry wires in:
 * booting or finding the daemon, whether a user unit manages it and the
 * restart of that unit, and the log of decisions the client takes without
 * drawing anything.
 */
export interface TUIHost {
  readonly bootDaemon: (options?: DaemonBootOptions) => Promise<DaemonBoot>;
  readonly isDaemonManaged: () => boolean;
  readonly restartManagedDaemon: () => Promise<void>;
  readonly logEvent: (line: string) => void;
}
