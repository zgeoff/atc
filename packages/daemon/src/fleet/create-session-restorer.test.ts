import { expect, mock, test } from 'bun:test';
import { systemClock, toAgentSessionID, toSessionID } from '@atc/core';
import type { AgentAdapter } from '@atc/plugin-api';
import { buildTargetIdentity } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import { buildMockAgentAdapter } from '@atc/test-utils';
import { createSessionRegistry } from '../sessions/create-session-registry';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildMockSession } from '../testing/build-mock-session';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import type { ExecutionTarget } from './build-execution-targets';
import { createSessionRestorer } from './create-session-restorer';

interface SetupConfig {
  readonly adapters: readonly AgentAdapter[];
  readonly targets: readonly ExecutionTarget[];
}

// A restorer over a real registry of the adapters and targets the test
// gives, with the fleet writer and the daemon's callbacks as recorders.
function setupTest(config: SetupConfig) {
  const callbacks = { onEvent: mock<() => void>(), getClock: () => systemClock };
  const fleet = { emitChange: mock<() => void>(), writeStatus: mock<() => void>() };

  const registry = createSessionRegistry({
    fallback: null,
    adapters: config.adapters,
    targets: config.targets,
    targetErrors: [],
    callbacks,
  });

  const restorer = createSessionRestorer({ registry, fleet, callbacks });

  return { registry, restorer, fleet, callbacks };
}

test('it restores an entry whose agent id is registered as waiting for its terminal', () => {
  const ctx = setupTest({
    adapters: [buildMockAgentAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: buildStubMemoryProvider(),
      }),
    ],
  });

  const session = ctx.restorer.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-1'),
      name: 'claude work',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-1'),
      agent: 'claude',
    }),
  );

  expect(session.lastMsg).toBe('waiting to restore');
});

test('it restores an entry whose agent id is unregistered with a message that the adapter is missing', () => {
  const ctx = setupTest({
    adapters: [buildMockAgentAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: buildStubMemoryProvider(),
      }),
    ],
  });

  const session = ctx.restorer.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-z-1'),
      name: 'glm work',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('z-1'),
      agent: 'zai',
    }),
  );

  expect(session.lastMsg).toBe("no adapter for 'zai'");
});

test('it links a restored sub-session to the parent already registered under its session id', () => {
  const ctx = setupTest({
    adapters: [buildMockAgentAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: buildStubMemoryProvider(),
      }),
    ],
  });

  const parent = ctx.restorer.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
    }),
  );

  const child = ctx.restorer.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: toSessionID('s-c-parent'),
    }),
  );

  expect(child.parent).toBe(parent.id);
});

test('it restores a sub-session whose parent is absent as a top-level session', () => {
  const ctx = setupTest({
    adapters: [buildMockAgentAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: buildStubMemoryProvider(),
      }),
    ],
  });

  const child = ctx.restorer.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: toSessionID('s-c-gone'),
    }),
  );

  expect(child.parent).toBeNull();
});

test("it restores an entry's prompt, result, and transcript path onto the session", () => {
  const ctx = setupTest({
    adapters: [buildMockAgentAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: buildStubMemoryProvider(),
      }),
    ],
  });

  const session = ctx.restorer.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-1'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-1'),
      agent: 'claude',
      prompt: 'go',
      result: 'done',
      transcriptPath: '/t.jsonl',
    }),
  );

  expect(session).toMatchObject({ prompt: 'go', result: 'done', transcriptPath: '/t.jsonl' });
  expect(session.transcriptSource).toBeUndefined();
});

test('it restores an entry under the session id its row holds', () => {
  const ctx = setupTest({
    adapters: [buildMockAgentAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: buildStubMemoryProvider(),
      }),
    ],
  });

  const session = ctx.restorer.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('7d3f0c1e-2b4a-4c5d-8e9f-0a1b2c3d4e5f'),
      name: 'claude work',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-1'),
      agent: 'claude',
    }),
  );

  expect(session.id).toBe(toSessionID('7d3f0c1e-2b4a-4c5d-8e9f-0a1b2c3d4e5f'));
});

test('it restores an entry with no agent session id as exited', () => {
  const ctx = setupTest({
    adapters: [buildMockAgentAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: buildStubMemoryProvider(),
      }),
    ],
  });

  const session = ctx.restorer.restore({
    sessionID: toSessionID('s-booting'),
    name: 'booting',
    cwd: '/work/proj',
    agent: 'claude',
  });

  expect(session.state).toBe('exited');
  expect(session.lastMsg).toBe('nothing to resume');
});

test('it restores an entry on a target this daemon lacks as exited with the target refusal', () => {
  const ctx = setupTest({
    adapters: [buildMockAgentAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: buildStubMemoryProvider(),
      }),
    ],
  });

  const session = ctx.restorer.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-gone'),
      name: 'stranded',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-gone'),
      agent: 'claude',
      target: 'box',
      targetIdentity: 'imp-like:test',
    }),
  );

  expect(session.state).toBe('exited');
  expect(session.lastMsg).toBe("no target 'box'");
});

test('it lists an exited entry left asleep as asleep on a target whose host can sleep', () => {
  const ctx = setupTest({
    adapters: [buildMockAgentAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'box',
        kind: 'imp-like',
        identity: 'imp-like:test',
        provider: buildStubMemoryProvider({ capabilities: { suspend: true }, remote: true }),
      }),
    ],
  });

  const session = ctx.restorer.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-sleeper'),
      name: 'sleeper',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-sleeper'),
      agent: 'claude',
      exited: true,
      desired: 'sleep',
      target: 'box',
      targetIdentity: 'imp-like:test',
    }),
  );

  expect(session).toMatchObject({
    state: 'exited',
    lastMsg: 'asleep',
    vm: 'asleep',
    suspended: true,
    attachment: 'detached',
  });
});

test('it lists an exited entry whose host went to sleep on its own as asleep while the operator still wants it running', () => {
  const ctx = setupTest({
    adapters: [buildMockAgentAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'box',
        kind: 'imp-like',
        identity: 'imp-like:test',
        provider: buildStubMemoryProvider({ capabilities: { suspend: true }, remote: true }),
      }),
    ],
  });

  const session = ctx.restorer.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-dozer'),
      name: 'dozer',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-dozer'),
      agent: 'claude',
      exited: true,
      suspended: true,
      target: 'box',
      targetIdentity: 'imp-like:test',
    }),
  );

  expect(session).toMatchObject({
    state: 'exited',
    lastMsg: 'asleep',
    desired: 'run',
    vm: 'asleep',
    suspended: true,
    attachment: 'detached',
  });
});

test('it marks a restored live session as still waiting for its terminal', () => {
  const ctx = setupTest({
    adapters: [buildMockAgentAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: buildStubMemoryProvider(),
      }),
    ],
  });

  ctx.restorer.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-1'),
      name: 'claude work',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-1'),
      agent: 'claude',
    }),
  );

  expect(ctx.restorer.isUnrestored(toSessionID('s-c-1'))).toBeTrue();
});

test('it leaves a restored exited session unmarked', () => {
  const ctx = setupTest({
    adapters: [buildMockAgentAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: buildStubMemoryProvider(),
      }),
    ],
  });

  ctx.restorer.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-1'),
      name: 'claude work',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-1'),
      agent: 'claude',
      exited: true,
    }),
  );

  expect(ctx.restorer.isUnrestored(toSessionID('s-c-1'))).toBeFalse();
});

test('it counts a restored session as live once its mark is removed', () => {
  const ctx = setupTest({
    adapters: [buildMockAgentAdapter()],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: buildTargetIdentity('local-pty', {}),
        provider: buildStubMemoryProvider(),
      }),
    ],
  });

  ctx.restorer.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-c-1'),
      name: 'claude work',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-1'),
      agent: 'claude',
    }),
  );

  ctx.restorer.removeUnrestoredMark(toSessionID('s-c-1'));

  expect(ctx.restorer.isUnrestored(toSessionID('s-c-1'))).toBeFalse();
});

test('it leaves a session alone when its checked identity is unchanged', () => {
  const ctx = setupTest({ adapters: [buildMockAgentAdapter()], targets: [] });

  const session = buildMockSession({
    target: 'box',
    targetIdentity: 'imp:0123456789abcdef',
    lastMsg: "target 'box' unavailable",
  });

  ctx.restorer.updateRestoredIdentity(session, 'imp:0123456789abcdef');

  expect(session.lastMsg).toBe("target 'box' unavailable");
  expect(ctx.callbacks.onEvent).not.toHaveBeenCalled();
});

test('it binds a session to a changed identity and resets its message to the restore wait', () => {
  const ctx = setupTest({ adapters: [buildMockAgentAdapter()], targets: [] });

  const session = buildMockSession({
    target: 'box',
    targetIdentity: 'imp:0123456789abcdef',
    lastMsg: "target 'box' binding unverified",
  });

  ctx.restorer.updateRestoredIdentity(session, 'imp:versioned');

  expect(session.targetIdentity).toBe('imp:versioned');
  expect(session.lastMsg).toBe('waiting to restore');
  expect(ctx.callbacks.onEvent).toHaveBeenCalledExactlyOnceWith('state', session);
});
