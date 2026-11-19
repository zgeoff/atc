import type { Clock } from '@atc/core';
import type { AgentAdapter, HarnessRelay, SpawnOptions, SpawnPlan } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';
import type { RuntimeAuthBinder } from '../auth/create-runtime-auth-binder';
import type { BridgeBinding } from '../auth/is-binding-current';
import type { PublishedRecords } from './create-published-records';
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

  readonly onBoot: (session: Session, cols: number, rows: number) => void;

  readonly onRelay: (binding: BridgeBinding, relay: HarnessRelay) => void;
  readonly onEvent: (kind: SessionEventKind, session: Session) => void;

  readonly onProcessEnded: (session: Session) => void;

  readonly startMessageBridge: (launch: MessageBridgeLaunch) => Promise<SpawnPlan | null>;

  readonly stopMessageBridge: (session: SessionID) => Promise<void>;

  readonly log: (line: string) => void;

  readonly now: () => number;

  readonly getClock: () => Clock;

  readonly getReporterSocketPath: () => string;

  readonly findAuthBinder: () => RuntimeAuthBinder | null;

  readonly findRecords: () => PublishedRecords | null;
}
