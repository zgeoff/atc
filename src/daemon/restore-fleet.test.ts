import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { restoreFleet } from './restore-fleet';
import type { SessionRuntime } from './session-runtime';
import { SessionManager } from './sessions';

const idleAdapter: AgentAdapter = {
  id: 'claude',
  headlessRunner: null,
  screenDetector: null,
  takesMessages: false,
  planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  normalizeHook: () => ({ kind: 'heartbeat' }),
  loadName: () => Promise.resolve(null),
  canResume: () => true,
  buildResumeCommand: () => null,
};

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'atc-restore-'));
  const store = await StateStore.open(join(dir, 'state.db'));

  const mgr = new SessionManager(idleAdapter, store, join(dir, 'status.json'), []);
  const runtimes = new Map<string, SessionRuntime>();

  return {
    store,
    mgr,
    findRuntime: (id: string) => runtimes.get(id),
    async [Symbol.asyncDispose]() {
      mgr.killAll();

      await store.stop();

      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it lists every restored session under the session id its row holds', async () => {
  await using ctx = await setupTest();

  await ctx.store.writeFleet([
    {
      sessionID: toSessionID('s-kept'),
      name: 'kept',
      cwd: '/tmp',
      agentSessionID: toAgentSessionID('c-kept'),
      agent: 'claude',
    },
  ]);

  const restored = await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  expect(restored).toBe(1);
  expect(ctx.mgr.sessions.map((s) => s.id)).toStrictEqual([toSessionID('s-kept')]);
});

test('it revives a listed dead session in place instead of listing its id twice', async () => {
  await using ctx = await setupTest();

  const s = ctx.mgr.spawn('/tmp', 'worker', '', 80, 24, toAgentSessionID('c-1'));

  await ctx.mgr.writeFleet();

  s.pty?.kill();
  const deadline = Date.now() + 5000;

  while (s.state !== 'exited' && Date.now() < deadline) {
    await Bun.sleep(10);
  }

  await restoreFleet({
    mgr: ctx.mgr,
    store: ctx.store,
    findRuntime: ctx.findRuntime,
    cols: 80,
    rows: 24,
    capMs: 0,
  });

  expect(ctx.mgr.sessions.map((x) => x.id)).toStrictEqual([s.id]);
  expect(s.pty).not.toBeNull();
});
