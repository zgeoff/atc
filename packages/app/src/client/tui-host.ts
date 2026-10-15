import type { DaemonBoot, DaemonBootOptions } from '@atc/protocol';

/**
 * What the TUI reaches outside its own process, which the entry wires in:
 * booting or finding the daemon, taking the daemon behind a socket out of
 * service for a restart, which resolves false when no pid for it is found,
 * the log of decisions the client takes without drawing anything, the
 * file the spawn picker keeps its source listings in, and the name of the
 * remote daemon from the config that the client connects to, or null for
 * the local daemon.
 */
export interface TUIHost {
  readonly bootDaemon: (options?: DaemonBootOptions) => Promise<DaemonBoot>;
  readonly restartDaemon: (socketPath: string) => Promise<boolean>;
  readonly logEvent: (line: string) => void;
  readonly listingCacheFile: string;
  readonly daemonName: string | null;
}
