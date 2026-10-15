import type { Clock } from '@atc/core';
import type { HarnessRelay } from '@atc/plugin-api';
import type { BridgeBinding } from './is-binding-current';
import type { PublishedRecords } from './published-records';
import type { RuntimeAuthBinder } from './runtime-auth-binder';
import type { Session } from './session';
import type { SessionEventKind } from './session-event-kind';

/**
 * What the session modules call back into the daemon through: the events
 * a session raises, where a background failure is logged, and the
 * daemon-wide settings each module reads at the moment it acts, since the
 * daemon sets them after the modules are built.
 */
export interface SessionCallbacks {
  readonly onOutput: (s: Session, data: string) => void;
  readonly onChange: () => void;

  // Called as a harness starts, before its first output can arrive, with
  // the terminal size it starts at.
  readonly onBoot: (s: Session, cols: number, rows: number) => void;

  // Takes each connection a harness's processes open through a provider's
  // own relay, with the binding of the harness start that opened it.
  readonly onRelay: (binding: BridgeBinding, relay: HarnessRelay) => void;
  readonly onEvent: (kind: SessionEventKind, s: Session) => void;

  // Called when a session's process is known to have ended: it exited or
  // it was killed.
  readonly onProcessEnded: (s: Session) => void;

  // Where a background failure is reported, one line at a time.
  readonly log: (line: string) => void;

  // The clock each remote launch's step timing reads, in milliseconds.
  readonly now: () => number;

  // The clock a session's creation and last attach are stamped with.
  readonly getClock: () => Clock;

  // The binder of each host's runtime auth, or null when the daemon has
  // none and refuses every start that needs one.
  readonly getAuthBinder: () => RuntimeAuthBinder | null;

  // Where each session's record is published, or null when sessions start
  // without one.
  readonly getRecords: () => PublishedRecords | null;
}
