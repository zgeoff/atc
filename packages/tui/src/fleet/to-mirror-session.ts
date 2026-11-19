import type { AgentID } from '@atc/core';
import { isRecord, toAgentID } from '@atc/core';
import type { SessionState, SessionViewState } from '@atc/protocol';
import { z } from 'zod';
import type { DaemonName } from './session-key';

export type HarnessLifecycle = 'running' | 'suspended' | 'exited';

export interface MirrorSession {
  readonly daemon: DaemonName;
  id: string;
  name: string;
  cwd: string;
  pinned: boolean;
  lastAttachedAt: number;
  repoRoot: string;
  state: SessionViewState;
  unread: boolean;
  lastMsg: string;
  createdAt: number;
  kind: 'pty' | 'headless';
  alive: boolean;
  resumable: boolean;
  canEject: boolean;
  agent: AgentID;
  parent: string | null;

  target: string;

  model: string | null;

  harness: HarnessLifecycle;
}

const REQUIRED_MIRROR_FIELDS_SCHEMA = z.looseObject({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  state: z.string(),
  unread: z.boolean(),
  lastMsg: z.string(),
  createdAt: z.number(),
  alive: z.boolean(),
});

export function toMirrorSession(value: unknown, daemon: DaemonName): MirrorSession | null {
  const parsed = REQUIRED_MIRROR_FIELDS_SCHEMA.safeParse(value);

  if (!parsed.success) {
    return null;
  }

  const record = parsed.data;

  return {
    daemon,
    id: record.id,
    name: record.name,
    cwd: record.cwd,
    pinned: record['pinned'] === true,
    lastAttachedAt:
      typeof record['lastAttachedAt'] === 'number' ? record['lastAttachedAt'] : record.createdAt,
    repoRoot: typeof record['repoRoot'] === 'string' ? record['repoRoot'] : record.cwd,
    state: parseSessionState(record.state),
    unread: record.unread,
    lastMsg: record.lastMsg,
    createdAt: record.createdAt,
    kind: record['kind'] === 'headless' ? 'headless' : 'pty',
    alive: record.alive,
    resumable: typeof record['agentSessionID'] === 'string',
    canEject: record['canEject'] === true,
    agent: toAgentID(record['agent']),
    parent: typeof record['parent'] === 'string' ? record['parent'] : null,
    target: getTargetID(record['locator']),
    model: typeof record['model'] === 'string' ? record['model'] : null,
    harness: parseHarnessLifecycle(record['lifecycle'], record.alive),
  };
}

const SESSION_STATES: readonly SessionState[] = ['running', 'needs_you', 'done', 'exited'];

// A state that a newer daemon adds shows as unknown.
function parseSessionState(state: string): SessionViewState {
  return SESSION_STATES.find((known) => known === state) ?? 'unknown';
}

function getTargetID(locator: unknown): string {
  if (isRecord(locator) && typeof locator['targetID'] === 'string') {
    return locator['targetID'];
  }

  return 'local';
}

function parseHarnessLifecycle(lifecycle: unknown, alive: boolean): HarnessLifecycle {
  if (isRecord(lifecycle)) {
    const harness = lifecycle['harness'];

    if (harness === 'running' || harness === 'suspended' || harness === 'exited') {
      return harness;
    }
  }

  return alive ? 'running' : 'exited';
}
