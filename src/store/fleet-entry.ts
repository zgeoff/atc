import { z } from 'zod';
import { toAgentID } from '../agents/agent-adapter';
import type { AgentID } from '../agents/agent-adapter';
import type { AgentSessionID } from '../shared/agent-session-id';
import { buildOptionalBoolean } from '../shared/build-optional-boolean';
import { isRecord } from '../shared/report';

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
  readonly loadFleet: () => Promise<FleetEntry[]>;
  readonly writeFleet: (entries: readonly FleetEntry[]) => Promise<void>;
}

// A stored fleet row's keys. name, cwd, and the resolved agentSessionID are
// required: a row missing any of them cannot restore a session, so the whole
// row parses to undefined rather than a half-built entry. Fleet files
// written before the id key was agent-neutral carry it under its Claude-era
// name, so agentSessionID is read off whichever key the row actually has
// before validation.
const FLEET_ENTRY_SCHEMA = z.preprocess(
  (value) => {
    if (!isRecord(value)) {
      return value;
    }

    return { ...value, agentSessionID: value['agentSessionID'] ?? value['claudeId'] };
  },
  z.object({
    name: z.string(),
    cwd: z.string(),
    agentSessionID: z.string(),
    agent: z.unknown().optional(),
    pinned: buildOptionalBoolean(),
    lastAttachedAt: buildOptionalNumber(),
    exited: buildOptionalBoolean(),
  }),
);

export function parseFleetEntry(raw: unknown): FleetEntry | undefined {
  const parsed = FLEET_ENTRY_SCHEMA.safeParse(raw);

  if (!parsed.success) {
    return undefined;
  }

  return {
    name: parsed.data.name,
    cwd: parsed.data.cwd,

    // oxlint-disable-next-line no-unsafe-type-assertion -- a stored fleet row's id column is an agent session id by contract; this is the one point where it is trusted
    agentSessionID: parsed.data.agentSessionID as AgentSessionID,
    agent: toAgentID(parsed.data.agent),
    ...(parsed.data.pinned === true ? { pinned: true } : {}),
    ...(parsed.data.lastAttachedAt === undefined
      ? {}
      : { lastAttachedAt: parsed.data.lastAttachedAt }),
    ...(parsed.data.exited === true ? { exited: true } : {}),
  };
}

function buildOptionalNumber() {
  return z.preprocess((v) => (typeof v === 'number' ? v : undefined), z.number().optional());
}
