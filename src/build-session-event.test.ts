import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from './agent-adapter';
import { buildSessionEvent } from './build-session-event';
import { SessionManager } from './sessions';
import type { Session } from './sessions';
import { StateStore } from './state-store';
import { toSessionID } from './to-session-id';

// Unit tests for the session-event builder: which notifications carry a
// descriptor and which emit nothing.
const idleAdapter: AgentAdapter = {
  id: 'claude',
  headlessRunner: null,
  screenDetector: null,
  planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  normalizeHook: () => ({ kind: 'heartbeat' }),
  loadName: () => Promise.resolve(null),
  canResume: () => true,
  buildResumeCommand: () => null,
};

function setupManager(): SessionManager {
  const dir = mkdtempSync(join(tmpdir(), 'atc-daemon-events-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return new SessionManager(
    idleAdapter,
    new StateStore(join(dir, 'state.db')),
    join(dir, 'status.json'),
    [],
  );
}

function buildGhostSession(): Session {
  return {
    id: toSessionID('ghost-session'),
    name: 'ghost',
    cwd: '/tmp',
    kind: 'pty',
    pty: null,
    state: 'exited',
    unread: false,
    lastMsg: '',
    agent: 'claude',
    pinned: false,
    lastAttachedAt: Date.now(),
    repoRoot: '/tmp',
    namedBy: 'auto',
    createdAt: Date.now(),
  };
}

test('it builds nothing for a session.state notification whose id has no descriptor', () => {
  const mgr = setupManager();
  let event: unknown = 'not called';

  expect(() => {
    event = buildSessionEvent(mgr, 'state', buildGhostSession());
  }).not.toThrow();

  expect(event).toBeNull();
});

test('it builds nothing for a session.added notification whose id has no descriptor', () => {
  const mgr = setupManager();

  expect(buildSessionEvent(mgr, 'added', buildGhostSession())).toBeNull();
});
