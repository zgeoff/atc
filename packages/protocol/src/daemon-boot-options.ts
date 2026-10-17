import type { Clock } from '@atc/core';
import type { DaemonPaths } from './daemon-paths';
import type { ProtocolMismatch } from './format-protocol-mismatch';

export interface DaemonBootOptions {
  // true stops the mismatched daemon, ending every session it hosts; false
  // or no callback rejects the boot and leaves that daemon running
  readonly onProtocolMismatch?: (mismatch: ProtocolMismatch) => Promise<boolean>;

  // set, the boot only waits for a daemon and never starts one, so a caller
  // started beside a managed daemon never races it for the state directory
  readonly waitForDaemonMs?: number;

  // Called once per boot, when a waiting boot first finds no daemon and
  // starts to wait instead of starting one; a retry after a protocol
  // mismatch that waits again does not call it a second time.
  readonly onWaitForDaemon?: () => void;

  // The time and the timers a waiting boot reads for its deadline and its
  // polls; the wall clock when absent.
  readonly clock?: Clock;

  // a boot given paths never starts a daemon, because `atc daemon` takes
  // only the environment's paths; it rejects at once when none answers
  readonly paths?: DaemonPaths;
}
