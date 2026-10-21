import type { Clock, SessionID } from '@atc/core';
import type { AgentAdapter, HarnessRelay, SpawnOptions, SpawnPlan } from '@atc/plugin-api';
import type { RuntimeAuthBinder } from '../auth/create-runtime-auth-binder';
import type { BridgeBinding } from '../auth/is-binding-current';
import type { PublishedRecords } from './published-records';
import type { Session } from './session';
import type { SessionEventKind } from './session-event-kind';

export interface MessageBridgeLaunch {
  readonly adapter: AgentAdapter;
  readonly session: SessionID;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly withheldEnv: readonly string[];
  readonly options: SpawnOptions;
}

export interface SessionCallbacks {
  readonly onOutput: (session: Session, data: string) => void;
  readonly onChange: () => void;

  // Called as a harness starts, before its first output can arrive, with
  // the terminal size it starts at.
  readonly onBoot: (session: Session, cols: number, rows: number) => void;

  // Takes each connection a harness's processes open through a provider's
  // own relay, with the binding of the harness start that opened it.
  readonly onRelay: (binding: BridgeBinding, relay: HarnessRelay) => void;
  readonly onEvent: (kind: SessionEventKind, session: Session) => void;

  // Called when a session's process is known to have ended: it exited or
  // it was killed.
  readonly onProcessEnded: (session: Session) => void;

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

  // the getters are read when a module acts, since the daemon sets these
  // after the modules are built; this clock stamps creation and last attach
  readonly getClock: () => Clock;

  // The binder of each host's runtime auth, or null when the daemon has
  // none and refuses every start that needs one.
  readonly findAuthBinder: () => RuntimeAuthBinder | null;

  // Where each session's record is published, or null when sessions start
  // without one.
  readonly findRecords: () => PublishedRecords | null;
}
