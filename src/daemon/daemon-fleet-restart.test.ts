import { expect, mock, test } from 'bun:test';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import type { RestoreSettled } from './restore-fleet';

test('it restores the stored sessions by itself after a restart', async () => {
  const clock = buildStubClock(0);
  const settles: RestoreSettled[] = [];

  const daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      registerTestCleanup(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: paths.dir }),
        buildMockFleetEntry({ sessionID: toSessionID('s-b'), cwd: paths.dir }),
      ]);

      // The fake agent never reports it booted, so the second session starts
      // once the first one's boot cap runs out on the stub clock.
      await seed.stop();

      return {
        adapter: buildMockAgentAdapter({ takesMessages: true }),
        restoreFleetOnRestart: true,
        restoreBootTimeoutMs: 10,
        clock,
        onRestoreSettled: (settled) => {
          settles.push(settled);
        },
      };
    },
  });

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([10]);
  });

  clock.advance(10);

  await waitFor(() => {
    expect(settles).toHaveLength(1);
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect(settles).toStrictEqual([{ restored: 2, outcome: 'finished' }]);

  expect(listed['sessions']).toMatchObject([
    { id: 's-a', alive: true },
    { id: 's-b', alive: true },
  ]);
});

test('it sends no message to the sessions it restores after a restart', async () => {
  const clock = buildStubClock(0);
  const settles: RestoreSettled[] = [];

  const daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      registerTestCleanup(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({
          sessionID: toSessionID('s-a'),
          agentSessionID: toAgentSessionID('a-a'),
          cwd: paths.dir,
        }),
        buildMockFleetEntry({ sessionID: toSessionID('s-b'), cwd: paths.dir }),
      ]);

      await seed.recordEvent(
        { atcId: toSessionID('s-a'), event: 'UserPromptSubmit', payload: { session_id: 'a-a' } },
        { kind: 'prompt-submitted' },
      );

      await seed.stop();

      return {
        adapter: buildMockAgentAdapter({ takesMessages: true }),
        restoreFleetOnRestart: true,
        restoreBootTimeoutMs: 10,
        clock,
        onRestoreSettled: (settled) => {
          settles.push(settled);
        },
      };
    },
  });

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([10]);
  });

  clock.advance(10);

  await waitFor(() => {
    expect(settles).toStrictEqual([{ restored: 2, outcome: 'finished' }]);
  });

  const store = await StateStore.open(daemon.dbPath);

  registerTestCleanup(() => store.stop());

  const pendingA = await store.collectPendingMessages({ atcID: toSessionID('s-a') });
  const pendingB = await store.collectPendingMessages({ atcID: toSessionID('s-b') });

  expect(pendingA).toStrictEqual([]);
  expect(pendingB).toStrictEqual([]);
});

test('it starts none of the stored sessions when the option is unset', async () => {
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] }));
  const skips: string[] = [];

  const daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      registerTestCleanup(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: paths.dir }),
      ]);

      await seed.stop();

      return {
        adapter: buildMockAgentAdapter({ planSpawn }),
        onRestoreSkipped: (reason) => {
          skips.push(reason);
        },
      };
    },
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect(skips).toStrictEqual(['disabled']);
  expect(listed['sessions']).toStrictEqual([]);
  expect(planSpawn.mock.calls).toStrictEqual([]);
});

test('it restores the stored sessions on fleet.restore when the option is unset', async () => {
  const daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      registerTestCleanup(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: paths.dir }),
      ]);

      await seed.stop();

      return { adapter: buildMockAgentAdapter() };
    },
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([{ id: 's-a', alive: true }]);
});

test('it starts none of the stored sessions when the option is false', async () => {
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] }));
  const skips: string[] = [];

  const daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      registerTestCleanup(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: paths.dir }),
      ]);

      await seed.stop();

      return {
        adapter: buildMockAgentAdapter({ planSpawn }),
        restoreFleetOnRestart: false,
        onRestoreSkipped: (reason) => {
          skips.push(reason);
        },
      };
    },
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect(skips).toStrictEqual(['disabled']);
  expect(listed['sessions']).toStrictEqual([]);
  expect(planSpawn.mock.calls).toStrictEqual([]);
});

test('it declines to restore an empty stored fleet by itself', async () => {
  const skips: string[] = [];

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter(),
      restoreFleetOnRestart: true,
      onRestoreSkipped: (reason) => {
        skips.push(reason);
      },
    }),
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect(skips).toStrictEqual(['empty']);
  expect(listed['sessions']).toStrictEqual([]);
});

test('it reports each fleet.restore that restores nothing once it settles', async () => {
  const settles: RestoreSettled[] = [];

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter(),
      onRestoreSettled: (settled) => {
        settles.push(settled);
      },
    }),
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitFor(() => {
    expect(settles).toStrictEqual([{ restored: 0, outcome: 'finished' }]);
  });
});

test('it joins a fleet.restore to the automatic restore while its stagger runs', async () => {
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] }));

  const daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      registerTestCleanup(() => seed.stop());

      await seed.writeFleet(
        ['s-a', 's-b', 's-c'].map((id) =>
          buildMockFleetEntry({ sessionID: toSessionID(id), cwd: paths.dir }),
        ),
      );

      // The fake agent never reports it booted, and no cap ends the wait, so
      // the stagger holds on the first session.
      await seed.stop();

      return {
        adapter: buildMockAgentAdapter({ planSpawn }),
        restoreFleetOnRestart: true,
        restoreBootTimeoutMs: 0,
      };
    },
  });

  await waitFor(() => {
    expect(planSpawn).toHaveBeenCalledOnce();
  });

  const joined = await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });
  const listed = await daemon.client.sendRequest('session.list');

  expect(planSpawn).toHaveBeenCalledOnce();
  expect(joined).toStrictEqual({ restored: 3 });
  expect(listed['sessions']).toMatchObject([{ id: 's-a' }, { id: 's-b' }, { id: 's-c' }]);
});

test('it starts no queued session once the daemon stops while the stagger runs', async () => {
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] }));
  const settles: RestoreSettled[] = [];

  const daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      registerTestCleanup(() => seed.stop());

      await seed.writeFleet(
        ['s-a', 's-b'].map((id) =>
          buildMockFleetEntry({ sessionID: toSessionID(id), cwd: paths.dir }),
        ),
      );

      // The fake agent never reports it booted, and no cap ends the wait, so
      // the stagger holds on the first session until the daemon stops.
      await seed.stop();

      return {
        adapter: buildMockAgentAdapter({ planSpawn }),
        restoreFleetOnRestart: true,
        restoreBootTimeoutMs: 0,
        onRestoreSettled: (settled) => {
          settles.push(settled);
        },
      };
    },
  });

  await waitFor(() => {
    expect(planSpawn).toHaveBeenCalledOnce();
  });

  await daemon.stop();

  await waitFor(() => {
    expect(settles).toHaveLength(1);
  });

  expect(planSpawn).toHaveBeenCalledOnce();
  expect(settles).toStrictEqual([{ restored: 2, outcome: 'stopped' }]);
});

test('it spawns nothing for a fleet.restore after the automatic restore settled', async () => {
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] }));
  const clock = buildStubClock(0);
  const settles: RestoreSettled[] = [];

  const daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      registerTestCleanup(() => seed.stop());

      await seed.writeFleet(
        ['s-a', 's-b'].map((id) =>
          buildMockFleetEntry({ sessionID: toSessionID(id), cwd: paths.dir }),
        ),
      );

      await seed.stop();

      return {
        adapter: buildMockAgentAdapter({ planSpawn }),
        restoreFleetOnRestart: true,
        restoreBootTimeoutMs: 10,
        clock,
        onRestoreSettled: (settled) => {
          settles.push(settled);
        },
      };
    },
  });

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([10]);
  });

  clock.advance(10);

  await waitFor(() => {
    expect(settles).toStrictEqual([{ restored: 2, outcome: 'finished' }]);
  });

  const again = await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect(planSpawn).toHaveBeenCalledTimes(2);
  expect(again).toStrictEqual({ restored: 0 });
});

test('it restores the rest of the fleet past rows whose repository cannot be resolved', async () => {
  const locked = setupTempDir('atc-daemon-fleet-locked-').dir;
  const clock = buildStubClock(0);
  const settles: RestoreSettled[] = [];

  await mkdir(join(locked, 'work'));
  await chmod(locked, 0o000);

  registerTestCleanup(() => chmod(locked, 0o700));

  const daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      registerTestCleanup(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-local'), cwd: paths.dir }),
        buildMockFleetEntry({
          sessionID: toSessionID('s-cloud'),
          cwd: join(paths.dir, 'cloud-main'),
          target: 'cloud',
          exited: true,
        }),
        buildMockFleetEntry({ sessionID: toSessionID('s-locked'), cwd: join(locked, 'work') }),
        buildMockFleetEntry({
          sessionID: toSessionID('s-killed'),
          cwd: paths.dir,
          exited: true,
        }),
        buildMockFleetEntry({ sessionID: toSessionID('s-after'), cwd: paths.dir }),
      ]);

      await seed.stop();

      return {
        adapter: buildMockAgentAdapter(),
        restoreFleetOnRestart: true,
        restoreBootTimeoutMs: 10,
        clock,
        onRestoreSettled: (settled) => {
          settles.push(settled);
        },
      };
    },
  });

  // The boot caps of the first two live sessions each hold the stagger
  // until the clock moves.
  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([10]);
  });

  clock.advance(10);

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([10]);
  });

  clock.advance(10);

  await waitFor(() => {
    expect(settles).toHaveLength(1);
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed['sessions']).toIncludeSameMembers([
    expect.objectContaining({ id: 's-local', kind: 'pty', alive: true }),
    expect.objectContaining({ id: 's-cloud', alive: false }),
    expect.objectContaining({ id: 's-locked' }),
    expect.objectContaining({ id: 's-killed', alive: false }),
    expect.objectContaining({ id: 's-after', kind: 'pty', alive: true }),
  ]);
});

test('it forgets an exited session on a target the daemon cannot use', async () => {
  const settles: RestoreSettled[] = [];

  const daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      registerTestCleanup(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({
          sessionID: toSessionID('s-cloud'),
          cwd: join(paths.dir, 'cloud-main'),
          target: 'cloud',
          exited: true,
        }),
      ]);

      await seed.stop();

      return {
        adapter: buildMockAgentAdapter(),
        restoreFleetOnRestart: true,
        onRestoreSettled: (settled) => {
          settles.push(settled);
        },
      };
    },
  });

  await waitFor(() => {
    expect(settles).toStrictEqual([{ restored: 1, outcome: 'finished' }]);
  });

  await daemon.client.sendRequest('session.forget', { session: 's-cloud' });

  const after = await daemon.client.sendRequest('session.list');

  expect(after['sessions']).toStrictEqual([]);
});

test('it lists a restored exited worktree session under the worktree itself', async () => {
  const settles: RestoreSettled[] = [];

  const daemon = await startTestDaemon({
    options: async (paths) => {
      const worktree = join(paths.dir, 'wt');

      await mkdir(worktree);

      await Bun.write(join(worktree, '.git'), `gitdir: ${paths.dir}/main/.git/worktrees/wt\n`);

      const seed = await StateStore.open(paths.dbPath);

      registerTestCleanup(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-wt'), cwd: worktree, exited: true }),
      ]);

      await seed.stop();

      return {
        adapter: buildMockAgentAdapter(),
        restoreFleetOnRestart: true,
        onRestoreSettled: (settled) => {
          settles.push(settled);
        },
      };
    },
  });

  await waitFor(() => {
    expect(settles).toStrictEqual([{ restored: 1, outcome: 'finished' }]);
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([{ id: 's-wt', repoRoot: join(daemon.dir, 'wt') }]);
});

test('it regroups a revived exited worktree session under its repository', async () => {
  const settles: RestoreSettled[] = [];

  const daemon = await startTestDaemon({
    options: async (paths) => {
      const worktree = join(paths.dir, 'wt');

      await mkdir(worktree);

      await Bun.write(join(worktree, '.git'), `gitdir: ${paths.dir}/main/.git/worktrees/wt\n`);

      const seed = await StateStore.open(paths.dbPath);

      registerTestCleanup(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-wt'), cwd: worktree, exited: true }),
      ]);

      await seed.stop();

      return {
        adapter: buildMockAgentAdapter(),
        restoreFleetOnRestart: true,
        onRestoreSettled: (settled) => {
          settles.push(settled);
        },
      };
    },
  });

  await waitFor(() => {
    expect(settles).toStrictEqual([{ restored: 1, outcome: 'finished' }]);
  });

  await daemon.client.sendRequest('session.adopt', { session: 's-wt', cols: 80, rows: 24 });

  const after = await daemon.client.sendRequest('session.list');

  expect(after['sessions']).toMatchObject([
    { id: 's-wt', alive: true, repoRoot: join(daemon.dir, 'main') },
  ]);
});
