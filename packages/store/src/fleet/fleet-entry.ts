import type { AgentID } from '@atc/core';
import type {
  AgentSessionID,
  DaemonID,
  GrantScope,
  SessionID,
  SessionWorkspace,
} from '@atcx/contract';

export interface FleetEntry {
  readonly sessionID: SessionID;
  readonly name: string;
  readonly cwd: string;

  readonly agentSessionID?: AgentSessionID;
  readonly agent: AgentID;
  readonly pinned?: boolean;
  readonly lastAttachedAt?: number;
  readonly exited?: boolean;

  readonly parent?: SessionID;

  readonly prompt?: string;

  readonly result?: string;

  readonly transcriptPath?: string;

  readonly model?: string;
  readonly effort?: string;

  readonly pluginDirs?: readonly string[];

  readonly target?: string;

  readonly targetIdentity?: string;

  readonly workspace?: SessionWorkspace;

  readonly withheldEnv?: readonly string[];

  readonly desired?: 'sleep' | 'stop';

  readonly hostKey?: SessionID;

  readonly authRevision?: number;

  readonly agentHome?: string;

  readonly suspended?: true;

  readonly atcAccess?: readonly GrantScope[];

  readonly spawner?: SessionID;

  readonly trustedRoot?: string;
}

export interface FleetStore {
  readonly daemonID: DaemonID;
  readonly loadFleet: () => Promise<FleetEntry[]>;
  readonly writeFleet: (
    entries: readonly FleetEntry[],
    removed?: readonly SessionID[],
  ) => Promise<void>;
  readonly updateFleetEntry: (sessionID: SessionID, fields: FleetEntryUpdate) => Promise<void>;

  readonly readAgentSessionHolders: (
    agentSessionID: AgentSessionID,
  ) => Promise<AgentSessionHolder[]>;
}

export interface AgentSessionHolder {
  readonly sessionID: SessionID;
  readonly hostKey: SessionID;
}

export interface FleetEntryUpdate {
  readonly result?: string;
  readonly transcriptPath?: string;
}
