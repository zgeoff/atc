import { toAgentID } from './agent-adapter';
import type { AgentID } from './agent-adapter';
import type { AgentSessionID } from './agent-session-id';
import { isRecord } from './report';

export interface FleetEntry {
  readonly name: string;
  readonly cwd: string;
  readonly agentSessionID: AgentSessionID;
  readonly agent: AgentID;
  readonly pinned?: boolean;
  readonly lastAttachedAt?: number;
  readonly exited?: boolean;
}

export interface FleetStore {
  readonly loadFleet: () => FleetEntry[];
  readonly writeFleet: (entries: readonly FleetEntry[]) => void;
}

export function parseFleetEntry(raw: unknown): FleetEntry | undefined {
  if (!isRecord(raw) || typeof raw['name'] !== 'string' || typeof raw['cwd'] !== 'string') {
    return undefined;
  }

  // Fleet files written before the id key was agent-neutral carry it under
  // its Claude-era name.
  const agentSessionID = raw['agentSessionID'] ?? raw['claudeId'];

  if (typeof agentSessionID !== 'string') {
    return undefined;
  }

  return {
    name: raw['name'],
    cwd: raw['cwd'],

    // oxlint-disable-next-line no-unsafe-type-assertion -- a legacy fleet file's id column is a stored agent session id by contract; this is the one point where it is trusted
    agentSessionID: agentSessionID as AgentSessionID,
    agent: toAgentID(raw['agent']),
    ...(raw['pinned'] === true ? { pinned: true } : {}),
    ...(typeof raw['lastAttachedAt'] === 'number' ? { lastAttachedAt: raw['lastAttachedAt'] } : {}),
    ...(raw['exited'] === true ? { exited: true } : {}),
  };
}
