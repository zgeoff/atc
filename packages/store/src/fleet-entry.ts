import type { AgentID, AgentSessionID, DaemonID, SessionID } from '@atc/core';
import type { SessionWorkspace } from '@atc/protocol';

// One fleet row. The atc session id keys it and stays the same for the
// session's whole life, across daemon restarts and fleet restores.
export interface FleetEntry {
  readonly sessionID: SessionID;
  readonly name: string;
  readonly cwd: string;

  // Absent until the agent reports its own session id; a row without one
  // restores as an exited session, since there is nothing to resume.
  readonly agentSessionID?: AgentSessionID;
  readonly agent: AgentID;
  readonly pinned?: boolean;
  readonly lastAttachedAt?: number;
  readonly exited?: boolean;

  // The atc session id of the session this one is a sub-session of.
  readonly parent?: SessionID;

  // The prompt the session was spawned with.
  readonly prompt?: string;

  // The agent's final message from the session's latest finished turn.
  readonly result?: string;

  // The transcript file the agent's hooks last reported for the session.
  readonly transcriptPath?: string;

  // The model and effort the session was spawned with; absent for a session
  // that runs on the agent's configured default.
  readonly model?: string;
  readonly effort?: string;

  // The plugin folders the spawn asked for, which every restart of the
  // session loads again; absent for a session that asked for none.
  readonly pluginDirs?: readonly string[];

  // The execution target the session runs on; a row without one restores
  // on the `local` target.
  readonly target?: string;

  // The identity the target had when the session started on it; a row
  // without one is bound to the implicit `local` target's identity.
  readonly targetIdentity?: string;

  // What the session's workspace was materialized from, for a session
  // spawned with a workspace source; a fleet write leaves it to the
  // materialization record that holds it.
  readonly workspace?: SessionWorkspace;

  // The environment variable names every harness the session starts goes
  // without, held with its ready workspace; never their values.
  readonly withheldEnv?: readonly string[];

  // What the operator asked of the harness: absent keeps it running,
  // `sleep` keeps its host asleep, and `stop` leaves it ended.
  readonly desired?: 'sleep' | 'stop';

  // The session whose host the harness runs on: its own id, or its
  // parent's when the two share one host. A row without one runs on a host
  // of its own.
  readonly hostKey?: SessionID;

  // The runtime auth revision the session's latest harness launched under,
  // so a harness a restore attaches to keeps it; absent for a harness that
  // takes no credential from impd's broker.
  readonly authRevision?: number;

  // Whether the harness is kept inside a host that went to sleep, whether
  // the operator or the host's own owner put it to sleep; absent for any
  // other harness.
  readonly suspended?: true;
}

export interface FleetStore {
  readonly daemonID: DaemonID;
  readonly loadFleet: () => Promise<FleetEntry[]>;
  readonly writeFleet: (
    entries: readonly FleetEntry[],
    removed?: readonly SessionID[],
  ) => Promise<void>;
  readonly updateFleetEntry: (sessionID: SessionID, fields: FleetEntryUpdate) => Promise<void>;
}

// The fields a session rewrites on its own row while it runs, without
// touching any sibling row.
export interface FleetEntryUpdate {
  readonly result?: string;
  readonly transcriptPath?: string;
}
