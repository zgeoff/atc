import type { Clock } from '@atc/core/system-clock';
import type { DaemonPaths } from './daemon-paths';
import type { ProtocolMismatch } from './format-protocol-mismatch';

/**
 * What a front end asks of a daemon boot: how to settle a protocol
 * mismatch, whether to wait for a daemon instead of starting one, the
 * clock its waits run on, and where to look for the daemon.
 */
export interface DaemonBootOptions {
  // Called when the daemon speaks another protocol version. Resolving true
  // stops that daemon and boots one from this build, which ends every
  // session it hosts; without the callback, or resolving false, the boot
  // rejects and the daemon keeps running.
  readonly onProtocolMismatch?: (mismatch: ProtocolMismatch) => Promise<boolean>;

  // When set, the boot never starts a daemon: it waits this many
  // milliseconds for one to answer, then rejects. A caller that a service
  // manager starts beside a managed daemon sets it, so the two never race
  // for the state directory.
  readonly waitForDaemonMs?: number;

  // Called once per boot, when a waiting boot first finds no daemon and
  // starts to wait instead of starting one; a retry after a protocol
  // mismatch that waits again does not call it a second time.
  readonly onWaitForDaemon?: () => void;

  // The time and the timers a waiting boot reads for its deadline and its
  // polls; the wall clock when absent.
  readonly clock?: Clock;

  // Where the boot looks for a running daemon and its pid; this process's
  // own paths when absent. `atc daemon` takes no paths of its own, only the
  // environment's, so a boot given paths never starts a daemon: when none
  // answers there, it rejects at once.
  readonly paths?: DaemonPaths;
}
