import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { toAgentSessionID, toSessionID } from '@atc/core';
import { buildTargetIdentity, createStateStore } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import {
  buildMockAgentAdapter,
  buildStubLog,
  createMigratedStateDB,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createSessionManager } from './create-session-manager';
import type { Session } from './session';
import type { SessionEventKind } from './session-event-kind';

// a manager the test holds after this setup detaches before the store goes
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-sessions-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const local = buildStubMemoryProvider({ kind: 'local-pty' });
  const recorder = buildStubLog();

  return {
    directory: temporaryDirectory.path,
    statusPath: join(temporaryDirectory.path, 'status.json'),
    store,
    local,
    log: recorder.log,
  };
}

test('it pins a sub-session on its own and leaves its parent unpinned', async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  manager.log = ctx.log;

  const parent = manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
    }),
  );

  const child = manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: toSessionID('s-c-parent'),
    }),
  );

  const pinned = manager.updateSession(child.id, { pinned: true });

  expect(pinned).toBeTrue();
  expect(child.pinned).toBeTrue();
  expect(parent.pinned).toBeFalse();
});

test("it refuses to pin a sub-session that runs in its parent's host and leaves it unpinned", async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  manager.log = ctx.log;

  manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
    }),
  );

  const child = manager.restore(
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

  const pinned = manager.updateSession(child.id, { pinned: true });

  expect(pinned).toBe('shared_host');
  expect(child.pinned).toBeFalse();
});

test('it detaches a sub-session and leaves its former parent pinned', async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  manager.log = ctx.log;

  const parent = manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
      pinned: true,
    }),
  );

  const child = manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: toSessionID('s-c-parent'),
    }),
  );

  const detached = manager.updateSession(child.id, { parent: null });

  expect(detached).toBeTrue();
  expect(child.parent).toBeNull();
  expect(child.pinned).toBeFalse();
  expect(parent.pinned).toBeTrue();
});

test("it refuses to detach a sub-session that runs in its parent's host and leaves it under the parent", async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  manager.log = ctx.log;

  manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
    }),
  );

  const child = manager.restore(
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

  const detached = manager.updateSession(child.id, { parent: null, pinned: true });

  expect(detached).toBe('shared_host');
  expect(child.parent).toBe(toSessionID('s-c-parent'));
  expect(child.pinned).toBeFalse();
});

test('it pins a sub-session in the update that detaches it', async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  manager.log = ctx.log;

  manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
    }),
  );

  const child = manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: toSessionID('s-c-parent'),
    }),
  );

  const updated = manager.updateSession(child.id, { parent: null, pinned: true });

  expect(updated).toBeTrue();
  expect(child.pinned).toBeTrue();
});

test('it persists a detached sub-session as top-level', async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  manager.log = ctx.log;

  manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
    }),
  );

  const child = manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: toSessionID('s-c-parent'),
    }),
  );

  manager.updateSession(child.id, { parent: null });

  await manager.writeFleet();

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

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  manager.log = ctx.log;

  const parent = manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
    }),
  );

  manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: toSessionID('s-c-parent'),
    }),
  );

  expect(manager.updateSession(parent.id, { pinned: true })).toBeTrue();
});

test("it keeps a finished turn's last message as the session result", async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  manager.log = ctx.log;

  const session = await manager.spawn(
    ctx.directory,
    'worker',
    'go',
    80,
    24,
    toAgentSessionID('c-1'),
  );

  manager.applyHook({ atcId: session.id, event: 'Stop', payload: {} });

  await manager.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: session.id,
      name: 'worker',
      cwd: ctx.directory,
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

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  manager.log = ctx.log;

  const session = await manager.spawn(
    ctx.directory,
    'worker',
    'go',
    80,
    24,
    toAgentSessionID('c-1'),
  );

  manager.applyHook({ atcId: session.id, event: 'SessionStart', payload: {} });

  await waitFor(() => {
    expect(session.namedBy).toBe('agent');
  });

  const updated = manager.updateSession(session.id, { name: 'typed', pinned: true });

  expect(updated).toBe('agent_named');
  expect(session.name).toBe('claude-named');
  expect(session.pinned).toBeTrue();
});

test('it truncates a stored result past 16 KiB', async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  manager.log = ctx.log;

  const session = await manager.spawn(
    ctx.directory,
    'worker',
    'go',
    80,
    24,
    toAgentSessionID('c-1'),
  );

  manager.applyHook({ atcId: session.id, event: 'Stop', payload: {} });

  await manager.writeFleet();

  const [stored] = await ctx.store.loadFleet();

  expect(stored?.result).toBe(`${'x'.repeat(16_381)}…`);
});

test('it persists the transcript path its hooks report', async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  manager.log = ctx.log;

  const session = await manager.spawn(ctx.directory, 'worker', '', 80, 24);

  manager.applyHook({ atcId: session.id, event: 'SessionStart', payload: {} });

  await manager.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: session.id,
      name: 'worker',
      cwd: ctx.directory,
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

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  manager.log = ctx.log;

  const finisher = await manager.spawn(
    ctx.directory,
    'finisher',
    'go',
    80,
    24,
    toAgentSessionID('c-1'),
  );

  const crasher = await manager.spawn(
    ctx.directory,
    'crasher',
    'go',
    80,
    24,
    toAgentSessionID('c-2'),
  );

  await manager.writeFleet();

  const [, crashed] = ctx.local.harnesses;

  invariant(crashed);

  crashed.emitExit({ exitCode: 1 });

  await waitFor(() => {
    expect(crasher.state).toBe('exited');
  });

  manager.applyHook({ atcId: finisher.id, event: 'Stop', payload: {} });

  await waitFor(async () => {
    const stored = await ctx.store.loadFleet();

    expect(stored).toStrictEqual([
      {
        sessionID: finisher.id,
        name: 'finisher',
        cwd: ctx.directory,
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
        cwd: ctx.directory,
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

test('it lets go of each harness when disposed', async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  manager.log = ctx.log;

  await manager.spawn(ctx.directory, 'worker', '', 80, 24);
  await manager.spawn(ctx.directory, 'helper', '', 80, 24);

  manager[Symbol.dispose]();

  expect(ctx.local.harnesses.map((harness) => harness.isDetached())).toStrictEqual([true, true]);
});

test('it allows a second disposal', async () => {
  const ctx = await setupTest();

  const manager = createSessionManager(
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
    manager.detachAll();
  });

  manager.log = ctx.log;

  await manager.spawn(ctx.directory, 'worker', '', 80, 24);

  manager[Symbol.dispose]();

  expect(() => {
    manager[Symbol.dispose]();
  }).not.toThrow();
});

test('it gives the boot handler it was built with the first spawn on the harness start', async () => {
  const ctx = await setupTest();

  const onBoot = mock<(session: Session, cols: number, rows: number) => void>();

  const manager = createSessionManager(
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
    [],
    { onBoot },
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const session = await manager.spawn(ctx.directory, 'lighthouse', '', 100, 30);

  expect(onBoot).toHaveBeenCalledExactlyOnceWith(session, 100, 30);
});

test('it gives the event handler it was built with a session restored at daemon boot', async () => {
  const ctx = await setupTest();

  const onEvent = mock<(kind: SessionEventKind, session: Session) => void>();

  const manager = createSessionManager(
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
    [],
    { onEvent },
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const restored = manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-harbor'),
      name: 'harbor',
      cwd: '/work/harbor',
      agentSessionID: toAgentSessionID('c-harbor'),
      agent: 'claude',
    }),
  );

  expect(onEvent).toHaveBeenCalledExactlyOnceWith('added', restored);
});
