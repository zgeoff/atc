import type { Config } from '@atc/config';
import type { DaemonBoot, DaemonBootOptions } from '@atc/protocol';
import type { ListingCache } from './listing-cache';

interface DaemonEntry {
  readonly bootDaemon: (options?: DaemonBootOptions) => Promise<DaemonBoot>;

  readonly listingCache: ListingCache;
}

export type TUIDaemon =
  | (DaemonEntry & {
      readonly name: null;

      readonly restartDaemon: (socketPath: string) => Promise<boolean>;
    })
  | (DaemonEntry & { readonly name: string });

export interface TUIHost {
  readonly logEvent: (line: string) => void;

  readonly readConfig: () => Config;

  readonly daemons: readonly TUIDaemon[];
}
