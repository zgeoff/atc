import type { Config } from '@atc/config';
import type { DaemonBoot, DaemonBootOptions } from '@atc/protocol';
import type { ListingCache } from './listing-cache';

// What the client takes from one daemon's entry: how to open it, and the
// listings it caches.
interface DaemonEntry {
  // rejects with a DaemonLinkFailureError, so the link can set its state.
  readonly bootDaemon: (options?: DaemonBootOptions) => Promise<DaemonBoot>;

  // one per daemon, so one host's listings never mix with another's.
  readonly listingCache: ListingCache;
}

// A daemon the client links to. The local daemon has no name and can be restarted from here; a
// daemon from the config's `daemons` map has its key as its name.
export type TUIDaemon =
  | (DaemonEntry & {
      readonly name: null;

      // resolves false when no pid is found for the daemon behind the socket.
      readonly restartDaemon: (socketPath: string) => Promise<boolean>;
    })
  | (DaemonEntry & { readonly name: string });

// What the client takes from the entry that starts it: every file it reads
// or writes, and every process it boots or restarts, comes through here.
export interface TUIHost {
  // the decisions the client takes without drawing anything.
  readonly logEvent: (line: string) => void;

  // the config as it stands on disk, read again on each call.
  readonly readConfig: () => Config;

  // the primary daemon first, then the `daemons` map in config order. The primary is the local
  // daemon, or the one remote daemon the `--daemon` flag names.
  readonly daemons: readonly TUIDaemon[];
}
