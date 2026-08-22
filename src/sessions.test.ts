import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from './agent-adapter';
import type { AgentSessionID } from './agent-session-id';
import { SessionManager } from './sessions';
import { StateStore } from './state-store';

// Registry-level tests: which agent id resolves to which adapter, and what a
// restored session does when its id resolves to none.
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

function setupManager(adapters: readonly AgentAdapter[] = []): SessionManager {
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return new SessionManager(
    idleAdapter,
    new StateStore(join(dir, 'state.db')),
    join(dir, 'status.json'),
    adapters,
  );
}

test('it restores an entry whose agent id is registered as waiting for its terminal', () => {
  const mgr = setupManager();

  const session = mgr.restore({
    name: 'claude work',
    cwd: '/tmp/proj',

    // oxlint-disable-next-line no-unsafe-type-assertion -- test fixture literal stands in for an agent-minted session id
    agentSessionID: 'c-1' as AgentSessionID,
    agent: 'claude',
  });

  expect(session.lastMsg).toBe('waiting to restore');
});

test('it restores an entry whose agent id is unregistered without reviving it as another agent', () => {
  const mgr = setupManager();

  const session = mgr.restore({
    name: 'glm work',
    cwd: '/tmp/proj',

    // oxlint-disable-next-line no-unsafe-type-assertion -- test fixture literal stands in for an agent-minted session id
    agentSessionID: 'z-1' as AgentSessionID,
    agent: 'zai',
  });

  expect(session.lastMsg).toBe("no adapter for 'zai'");
  expect(mgr.adoptTerminal(session.id, 80, 24)).toBeNull();
});

test('it resolves an agent id to the adapter that declares it, not to the default', () => {
  const gateway: AgentAdapter = { ...idleAdapter, id: 'zai' };
  const mgr = setupManager([gateway]);

  expect(mgr.findAdapter('zai')).toBe(gateway);
  expect(mgr.findAdapter('claude')).toBe(idleAdapter);
  expect(mgr.findAdapter('grok')).toBeNull();
});

test('it reports no screen detector when no registered adapter provides one', () => {
  const other: AgentAdapter = { ...idleAdapter, id: 'zai' };
  const mgr = setupManager([other]);

  expect(mgr.hasScreenDetector).toBe(false);
});

test('it reports a screen detector when a registered adapter provides one', () => {
  const withDetector: AgentAdapter = {
    ...idleAdapter,
    id: 'zai',
    screenDetector: { detectAttention: () => null },
  };

  const mgr = setupManager([withDetector]);

  expect(mgr.hasScreenDetector).toBe(true);
});
