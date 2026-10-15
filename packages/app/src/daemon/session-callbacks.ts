import type { Clock, SessionID } from '@atc/core';
import type { AgentAdapter, HarnessRelay, SpawnOptions, SpawnPlan } from '@atc/plugin-api';
import type { BridgeBinding } from './is-binding-current';
import type { PublishedRecords } from './published-records';
import type { RuntimeAuthBinder } from './runtime-auth-binder';
import type { Session } from './session';
import type { SessionEventKind } from './session-event-kind';

/**
 * A launch on the daemon's machine whose agent may take its messages
 * through a bridge in the daemon: the agent, the session, the folder its
 * terminal starts in, the variables it starts with on top of the daemon's
 * own and the names it goes without, and the spawn's choices.
 */
export interface MessageBridgeLaunch {
  readonly adapter: AgentAdapter;
  readonly session: SessionID;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly withheldEnv: readonly string[];
  readonly options: SpawnOptions;
}

/**
 * What the session modules call back into the daemon through: the events
 * a session raises, which the daemon gives when the modules are built, where
 * a background failure is logged, and the daemon-wide settings each module
 * reads at the moment it acts, since the daemon sets them after the modules
 * are built.
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

  // Starts the bridge that takes a local session's messages, when its agent
  // has one, and resolves with the plan that starts the terminal against
  // it; null when the agent has none.
  readonly startMessageBridge: (launch: MessageBridgeLaunch) => Promise<SpawnPlan | null>;

  // Stops the session's bridge, if it has one, for a launch that failed
  // after the bridge started.
  readonly stopMessageBridge: (session: SessionID) => Promise<void>;

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
