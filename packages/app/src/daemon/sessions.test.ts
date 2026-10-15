import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { toAgentSessionID, toSessionID } from '@atc/core';
import { LocalPTYProvider } from '@atc/execution-local';
import { StateStore, buildTargetIdentity } from '@atc/store';
import { buildMockFleetEntry, createMigratedStateDB } from '@atc/store/testing';
import {
  buildMockAgentAdapter,
  buildStubLog,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { SessionManager } from './sessions';

// The fixed parts every session manager test shares: a real state store, a
// recorder of logged lines, and the `local` provider on this machine's
// terminals. Each test builds its targets over it. A manager the test holds
// after this setup detaches before the store and the provider go.
async function setupTest() {
  const tmp = setupTempDir('atc-sessions-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const local = new LocalPTYProvider();

  registerTestCleanup(() => local.dispose());

  const recorder = buildStubLog();

  return {
    dir: tmp.dir,
    statusPath: join(tmp.dir, 'status.json'),
    store,
    local,
    log: recorder.log,
  };
}

test('it pins a sub-session on its own and leaves its parent unpinned', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      }),
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  const parent = mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
    }),
  );

  const child = mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: toSessionID('s-c-parent'),
    }),
  );

  const pinned = mgr.updateSession(child.id, { pinned: true });

  expect(pinned).toBeTrue();
  expect(child.pinned).toBeTrue();
  expect(parent.pinned).toBeFalse();
});

test("it refuses to pin a sub-session that runs in its parent's host and leaves it unpinned", async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      }),
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
    }),
  );

  const child = mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: toSessionID('s-c-parent'),
      hostKey: toSessionID('s-c-parent'),
    }),
  );

  const pinned = mgr.updateSession(child.id, { pinned: true });

  expect(pinned).toBe('shared_host');
  expect(child.pinned).toBeFalse();
});

test('it detaches a sub-session and leaves its former parent pinned', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      }),
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  const parent = mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
      pinned: true,
    }),
  );

  const child = mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: toSessionID('s-c-parent'),
    }),
  );

  const detached = mgr.updateSession(child.id, { parent: null });

  expect(detached).toBeTrue();
  expect(child.parent).toBeNull();
  expect(child.pinned).toBeFalse();
  expect(parent.pinned).toBeTrue();
});

test("it refuses to detach a sub-session that runs in its parent's host and leaves it under the parent", async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      }),
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
    }),
  );

  const child = mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: toSessionID('s-c-parent'),
      hostKey: toSessionID('s-c-parent'),
    }),
  );

  const detached = mgr.updateSession(child.id, { parent: null, pinned: true });

  expect(detached).toBe('shared_host');
  expect(child.parent).toBe(toSessionID('s-c-parent'));
  expect(child.pinned).toBeFalse();
});

test('it pins a sub-session in the update that detaches it', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      }),
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
    }),
  );

  const child = mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: toSessionID('s-c-parent'),
    }),
  );

  const updated = mgr.updateSession(child.id, { parent: null, pinned: true });

  expect(updated).toBeTrue();
  expect(child.pinned).toBeTrue();
});

test('it persists a detached sub-session as top-level', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      }),
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
    }),
  );

  const child = mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: toSessionID('s-c-parent'),
    }),
  );

  mgr.updateSession(child.id, { parent: null });

  await mgr.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: expect.toBeNumber(),
    },
    {
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: expect.toBeNumber(),
    },
  ]);
});

test('it pins a parent that has a sub-session', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      }),
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  const parent = mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
    }),
  );

  mgr.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: toSessionID('s-c-parent'),
    }),
  );

  expect(mgr.updateSession(parent.id, { pinned: true })).toBeTrue();
});

test("it keeps a finished turn's last message as the session result", async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [
      buildMockAgentAdapter({
        planHookEvents: () => ({ events: [{ kind: 'turn-done', result: 'all green' }] }),
      }),
    ],
    [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      }),
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  const s = await mgr.spawn(ctx.dir, 'worker', 'go', 80, 24, toAgentSessionID('c-1'));

  mgr.applyHook({ atcId: s.id, event: 'Stop', payload: {} });

  await mgr.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: s.id,
      name: 'worker',
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-1'),
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: expect.toBeNumber(),
      prompt: 'go',
      result: 'all green',
    },
  ]);
});

test('it keeps a name the agent set and reports the rename it skipped', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [
      buildMockAgentAdapter({
        planHookEvents: () => ({ events: [{ kind: 'started', nameSource: '/t/c-1.jsonl' }] }),
        loadName: () => Promise.resolve({ name: 'claude-named', namedBy: 'agent' }),
      }),
    ],
    [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      }),
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  const s = await mgr.spawn(ctx.dir, 'worker', 'go', 80, 24, toAgentSessionID('c-1'));

  mgr.applyHook({ atcId: s.id, event: 'SessionStart', payload: {} });

  await waitFor(() => {
    expect(s.namedBy).toBe('agent');
  });

  const updated = mgr.updateSession(s.id, { name: 'typed', pinned: true });

  expect(updated).toBe('agent_named');
  expect(s.name).toBe('claude-named');
  expect(s.pinned).toBeTrue();
});

test('it truncates a stored result past 16 KiB', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [
      buildMockAgentAdapter({
        planHookEvents: () => ({ events: [{ kind: 'turn-done', result: 'x'.repeat(20_000) }] }),
      }),
    ],
    [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      }),
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  const s = await mgr.spawn(ctx.dir, 'worker', 'go', 80, 24, toAgentSessionID('c-1'));

  mgr.applyHook({ atcId: s.id, event: 'Stop', payload: {} });

  await mgr.writeFleet();

  const [stored] = await ctx.store.loadFleet();

  expect(stored?.result).toBe(`${'x'.repeat(16_381)}…`);
});

test('it persists the transcript path its hooks report', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [
      buildMockAgentAdapter({
        planHookEvents: () => ({
          events: [
            {
              kind: 'started',
              agentSessionID: toAgentSessionID('c-2'),
              transcriptSource: '/t/c-2.jsonl',
            },
          ],
        }),
      }),
    ],
    [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      }),
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  const s = await mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  mgr.applyHook({ atcId: s.id, event: 'SessionStart', payload: {} });

  await mgr.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: s.id,
      name: 'worker',
      cwd: ctx.dir,
      agentSessionID: toAgentSessionID('c-2'),
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: expect.toBeNumber(),
      transcriptPath: '/t/c-2.jsonl',
    },
  ]);
});

test('it keeps a crashed sibling restorable as live when another session finishes a turn', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [
      buildMockAgentAdapter({
        planHookEvents: () => ({ events: [{ kind: 'turn-done', result: 'all green' }] }),
      }),
    ],
    [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      }),
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  const finisher = await mgr.spawn(ctx.dir, 'finisher', 'go', 80, 24, toAgentSessionID('c-1'));
  const crasher = await mgr.spawn(ctx.dir, 'crasher', 'go', 80, 24, toAgentSessionID('c-2'));

  await mgr.writeFleet();

  crasher.pty?.kill();

  await waitFor(() => {
    expect(crasher.state).toBe('exited');
  });

  mgr.applyHook({ atcId: finisher.id, event: 'Stop', payload: {} });

  await waitFor(async () => {
    const stored = await ctx.store.loadFleet();

    expect(stored).toStrictEqual([
      {
        sessionID: finisher.id,
        name: 'finisher',
        cwd: ctx.dir,
        agentSessionID: toAgentSessionID('c-1'),
        agent: 'claude',
        target: 'local',
        targetIdentity: buildTargetIdentity('local-pty', {}),
        lastAttachedAt: expect.toBeNumber(),
        prompt: 'go',
        result: 'all green',
      },
      {
        sessionID: crasher.id,
        name: 'crasher',
        cwd: ctx.dir,
        agentSessionID: toAgentSessionID('c-2'),
        agent: 'claude',
        target: 'local',
        targetIdentity: buildTargetIdentity('local-pty', {}),
        lastAttachedAt: expect.toBeNumber(),
        prompt: 'go',
      },
    ]);
  });
});

test('it ends each harness on this machine when disposed', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      }),
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  const s = await mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const harness = s.pty;

  invariant(harness);

  mgr[Symbol.dispose]();

  const exited = await harness.waitForExit(2000);

  expect(exited).toBeTrue();
});

test('it allows a second disposal', async () => {
  const ctx = await setupTest();

  const mgr = new SessionManager(
    buildMockAgentAdapter(),
    ctx.store,
    ctx.statusPath,
    [],
    [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: ctx.local,
      }),
    ],
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  mgr.log = ctx.log;

  await mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  mgr[Symbol.dispose]();

  expect(() => {
    mgr[Symbol.dispose]();
  }).not.toThrow();
});
