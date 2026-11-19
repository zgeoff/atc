import type {
  HooksConfig,
  InvalidGitTransports,
  TargetConfigError,
  WorkspaceCleanupConfig,
} from '@atc/config';
import type { AgentID, Clock } from '@atc/core';
import type { AgentAdapter, SourceProvider } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';
import type { ExecutionTarget } from './fleet/build-execution-targets';
import type { RestoreSettled } from './fleet/restore-fleet';
import type { MenuTiming } from './sessions/menu-terminal';
import type { SettleScheduler } from './sessions/run-eject-handoff';
import type { ListenOptions } from './transport/listen-options';

export interface DaemonOptions {
  readonly socketPath: string;
  readonly reporterSocketPath: string;

  readonly build: string;
  readonly adapter?: AgentAdapter | null;

  // Lookup never falls back across ids: a session whose agent has no registered adapter is
  // unsupported, not a spawn of the default agent.
  readonly adapters?: readonly AgentAdapter[];

  readonly defaultAgent?: AgentID;

  readonly targets: readonly ExecutionTarget[];
  readonly defaultTarget?: string | null;

  readonly targetErrors?: readonly TargetConfigError[];

  readonly principals?: ReadonlyMap<string, readonly string[]> | null;

  readonly dbPath: string;

  readonly pidPath?: string;

  readonly eventsSocketPath?: string;

  readonly hooks?: HooksConfig;

  readonly statusPath?: string;

  readonly queueBytes?: number;

  readonly ejectSettleMs?: number;

  readonly scheduleEjectSettle?: SettleScheduler;

  readonly failedSpawnExitWaitMs?: number;

  readonly restoreBootTimeoutMs?: number;

  readonly restoreRetryDelaysMs?: readonly number[];
  readonly tapGraceMs?: number;

  readonly clock?: Clock;

  readonly menuTiming?: MenuTiming;

  readonly restoreFleetOnRestart?: boolean;

  readonly onRestoreSettled?: (settled: RestoreSettled) => void;

  readonly onRestoreSkipped?: (reason: 'disabled' | 'empty') => void;

  readonly onNoteIgnored?: (sessionID: string, kind: 'note' | 'answered' | 'unanswered') => void;

  readonly forgetConfirmMs?: number;

  readonly forgetClock?: () => number;

  readonly eventSweepClock?: Clock;

  readonly onLastUsedUnchanged?: (sessionID: SessionID) => void;

  readonly listen?: ListenOptions;

  readonly onQuit?: () => void;

  readonly log?: (line: string) => void;

  readonly onDetectSkipped?: (sessionID: SessionID) => void;

  readonly sources?: readonly SourceProvider[];

  readonly ghBin?: string;

  readonly gitTransports?: readonly string[] | InvalidGitTransports;

  readonly workspaceRoots?: Readonly<{
    root: string | null;
    targetRoots: ReadonlyMap<string, string>;
  }>;

  readonly workspaceCleanup?: WorkspaceCleanupConfig;

  readonly homeDir?: string;
}
