import { z } from 'zod';
import { toAgentID } from '../agents/agent-adapter';
import type { AgentID } from '../agents/agent-adapter';
import type { SessionState } from '../daemon/sessions';

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
}

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
  };
}
