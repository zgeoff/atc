import type { Clock } from '@atc/core';
import type { ProtocolMismatch } from '../version-mismatch/format-protocol-mismatch';
import type { DaemonPaths } from './daemon-paths';

export interface DaemonBootOptions {
  readonly onProtocolMismatch?: (mismatch: ProtocolMismatch) => Promise<boolean>;

  readonly waitForDaemonMs?: number;

  readonly onWaitForDaemon?: () => void;

  readonly clock?: Clock;

  readonly paths?: DaemonPaths;
}
