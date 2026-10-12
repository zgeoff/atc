import { z } from 'zod';
import type { SessionState } from '../protocol/session-state';
import type { AgentID } from '../shared/agent-id';
import { isRecord } from '../shared/report';
import { toAgentID } from '../shared/to-agent-id';

export interface MirrorSession {
  id: string;
  name: string;
  cwd: string;
  pinned: boolean;
  lastAttachedAt: number;
  repoRoot: string;
  state: SessionState;
  unread: boolean;
  lastMsg: string;
  createdAt: number;
  kind: 'pty' | 'headless';
  alive: boolean;
  resumable: boolean;
  canEject: boolean;
  agent: AgentID;
  parent: string | null;

  // The execution target the session runs on, from the descriptor's
  // locator; 'local' when the descriptor carries none.
  target: string;

  // The model the session was spawned with, as the daemon stores it: null
  // when it runs the agent's default. An alias a gateway's models map
  // resolves is resolved at draw time, where the map is at hand.
  model: string | null;

  // Where the session's harness stands: running, suspended inside a
  // sleeping host, or exited. Distinct from `state`, which carries the
  // attention a live harness last reported.
  harness: HarnessLifecycle;
}

export type HarnessLifecycle = 'running' | 'suspended' | 'exited';

// Only the fields a mirror can't function without; an unparseable descriptor
// is skipped rather than thrown into the event loop. Unknown keys pass
// through so the lenient fallbacks below can still read them.
const REQUIRED_MIRROR_FIELDS_SCHEMA = z.looseObject({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  state: z.enum(['running', 'needs_you', 'done', 'exited']),
  unread: z.boolean(),
  lastMsg: z.string(),
  createdAt: z.number(),
  alive: z.boolean(),
});

export function toMirrorSession(value: unknown): MirrorSession | null {
  const parsed = REQUIRED_MIRROR_FIELDS_SCHEMA.safeParse(value);

  if (!parsed.success) {
    return null;
  }

  const record = parsed.data;

  return {
    id: record.id,
    name: record.name,
    cwd: record.cwd,
    pinned: record['pinned'] === true,
    lastAttachedAt:
      typeof record['lastAttachedAt'] === 'number' ? record['lastAttachedAt'] : record.createdAt,
    repoRoot: typeof record['repoRoot'] === 'string' ? record['repoRoot'] : record.cwd,
    state: record.state,
    unread: record.unread,
    lastMsg: record.lastMsg,
    createdAt: record.createdAt,
    kind: record['kind'] === 'headless' ? 'headless' : 'pty',
    alive: record.alive,
    resumable: typeof record['agentSessionID'] === 'string',
    canEject: record['canEject'] === true,
    agent: toAgentID(record['agent']),
    parent: typeof record['parent'] === 'string' ? record['parent'] : null,
    target: readTargetID(record['locator']),
    model: typeof record['model'] === 'string' ? record['model'] : null,
    harness: readHarnessLifecycle(record['lifecycle'], record.alive),
  };
}

// The locator's target id, with 'local' for a descriptor that carries no
// locator at all.
function readTargetID(locator: unknown): string {
  if (isRecord(locator) && typeof locator['targetID'] === 'string') {
    return locator['targetID'];
  }

  return 'local';
}

// The harness layer of a descriptor's lifecycle, falling back to what the
// alive flag says when the lifecycle is missing.
function readHarnessLifecycle(lifecycle: unknown, alive: boolean): HarnessLifecycle {
  if (isRecord(lifecycle)) {
    const harness = lifecycle['harness'];

    if (harness === 'running' || harness === 'suspended' || harness === 'exited') {
      return harness;
    }
  }

  return alive ? 'running' : 'exited';
}
