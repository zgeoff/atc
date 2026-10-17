import type { DaemonBoot, DaemonBootOptions } from '@atc/protocol';

export interface TUIHost {
  readonly bootDaemon: (options?: DaemonBootOptions) => Promise<DaemonBoot>;

  // resolves false when no pid is found for the daemon behind the socket.
  readonly restartDaemon: (socketPath: string) => Promise<boolean>;

  // the decisions the client takes without drawing anything.
  readonly logEvent: (line: string) => void;
  readonly listingCacheFile: string;

  // the configured remote daemon the client connects to, or null for the local one.
  readonly daemonName: string | null;
}
