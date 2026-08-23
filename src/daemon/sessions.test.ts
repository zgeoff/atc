import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { StateStore } from '../store/state-store';
import { SessionManager } from './sessions';

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

async function setupManager(adapters: readonly AgentAdapter[] = []): Promise<SessionManager> {
  const dir = mkdtempSync(join(tmpdir(), 'atc-sessions-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const store = await StateStore.open(join(dir, 'state.db'));

  return new SessionManager(idleAdapter, store, join(dir, 'status.json'), adapters);
}

test('it restores an entry whose agent id is registered as waiting for its terminal', async () => {
  const mgr = await setupManager();

  const session = mgr.restore({
    name: 'claude work',
    cwd: '/tmp/proj',

    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
  });

  expect(session.lastMsg).toBe('waiting to restore');
});

test('it restores an entry whose agent id is unregistered without reviving it as another agent', async () => {
  const mgr = await setupManager();

  const session = mgr.restore({
    name: 'glm work',
    cwd: '/tmp/proj',

    agentSessionID: toAgentSessionID('z-1'),
    agent: 'zai',
  });

  expect(session.lastMsg).toBe("no adapter for 'zai'");
  expect(mgr.adoptTerminal(session.id, 80, 24)).toBeNull();
});

test('it resolves an agent id to the adapter that declares it, not to the default', async () => {
  const gateway: AgentAdapter = { ...idleAdapter, id: 'zai' };

  const mgr = await setupManager([gateway]);

  expect(mgr.findAdapter('zai')).toBe(gateway);
  expect(mgr.findAdapter('claude')).toBe(idleAdapter);
  expect(mgr.findAdapter('grok')).toBeNull();
});

test('it reports no screen detector when no registered adapter provides one', async () => {
  const other: AgentAdapter = { ...idleAdapter, id: 'zai' };

  const mgr = await setupManager([other]);

  expect(mgr.hasScreenDetector).toBe(false);
});

test('it reports a screen detector when a registered adapter provides one', async () => {
  const withDetector: AgentAdapter = {
    ...idleAdapter,
    id: 'zai',
    screenDetector: { detectAttention: () => null },
  };

  const mgr = await setupManager([withDetector]);

  expect(mgr.hasScreenDetector).toBe(true);
});
