import type { Config } from '@atc/config';
import type { DaemonBoot, DaemonBootOptions } from '@atc/protocol';
import type { ListingCache } from './listing-cache';

// What the client takes from the entry that starts it: every file it reads
// or writes, and every process it boots or restarts, comes through here.
export interface TUIHost {
  readonly bootDaemon: (options?: DaemonBootOptions) => Promise<DaemonBoot>;

  // resolves false when no pid is found for the daemon behind the socket.
  readonly restartDaemon: (socketPath: string) => Promise<boolean>;

  // the decisions the client takes without drawing anything.
  readonly logEvent: (line: string) => void;

  // the config as it stands on disk, read again on each call.
  readonly readConfig: () => Config;
  readonly listingCache: ListingCache;

  // the configured remote daemon the client connects to, or null for the local one.
  readonly daemonName: string | null;
}
