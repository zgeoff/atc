import { expect, mock, onTestFinished, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import type { FleetEntry } from '../store/fleet-entry';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import type { RestoreSettled } from './restore-fleet';

test('it restores the stored sessions by itself after a restart', async () => {
  const clock = buildStubClock(0);
  const settles: RestoreSettled[] = [];

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      await writeSeedFleet(paths.dbPath, [
        buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: paths.dir }),
        buildMockFleetEntry({ sessionID: toSessionID('s-b'), cwd: paths.dir }),
      ]);

      // The fake agent never reports it booted, so the second session starts
      // once the first one's boot cap runs out on the stub clock.
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

  await Bun.sleep(500);

  console.log('DBG', clock.collectPending(), daemon.logs, settles);

  await waitFor(() => {
    expect(settles).toHaveLength(1);
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect({ settles, sessions: listed['sessions'] }).toMatchObject({
    settles: [{ restored: 2, outcome: 'finished' }],
    sessions: [
      { id: 's-a', alive: true },
      { id: 's-b', alive: true },
    ],
  });
});

test('it sends no message to the sessions it restores after a restart', async () => {
  const clock = buildStubClock(0);
  const settles: RestoreSettled[] = [];

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

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

  onTestFinished(() => store.stop());

  const pending = {
    a: await store.collectPendingMessages({ atcID: toSessionID('s-a') }),
    b: await store.collectPendingMessages({ atcID: toSessionID('s-b') }),
  };

  expect(pending).toStrictEqual({ a: [], b: [] });
});

test('it starts none of the stored sessions when the option is unset', async () => {
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] }));
  const skips: string[] = [];

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      await writeSeedFleet(paths.dbPath, [
        buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: paths.dir }),
      ]);

      return {
        adapter: buildMockAgentAdapter({ planSpawn }),
        onRestoreSkipped: (reason) => {
          skips.push(reason);
        },
      };
    },
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect({ skips, sessions: listed['sessions'], spawns: planSpawn.mock.calls }).toStrictEqual({
    skips: ['disabled'],
    sessions: [],
    spawns: [],
  });
});

test('it restores the stored sessions on fleet.restore when the option is unset', async () => {
  await using daemon = await startTestDaemon({
    options: async (paths) => {
      await writeSeedFleet(paths.dbPath, [
        buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: paths.dir }),
      ]);

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

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      await writeSeedFleet(paths.dbPath, [
        buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: paths.dir }),
      ]);

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

  expect({ skips, sessions: listed['sessions'], spawns: planSpawn.mock.calls }).toStrictEqual({
    skips: ['disabled'],
    sessions: [],
    spawns: [],
  });
});

test('it declines to restore an empty stored fleet by itself', async () => {
  const skips: string[] = [];

  await using daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter(),
      restoreFleetOnRestart: true,
      onRestoreSkipped: (reason) => {
        skips.push(reason);
      },
    }),
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect({ skips, sessions: listed['sessions'] }).toStrictEqual({ skips: ['empty'], sessions: [] });
});

test('it reports each fleet.restore that restores nothing once it settles', async () => {
  const settles: RestoreSettled[] = [];

  await using daemon = await startTestDaemon({
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

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      await writeSeedFleet(
        paths.dbPath,
        ['s-a', 's-b', 's-c'].map((id) =>
          buildMockFleetEntry({ sessionID: toSessionID(id), cwd: paths.dir }),
        ),
      );

      // The fake agent never reports it booted, and no cap ends the wait, so
      // the stagger holds on the first session.
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

  expect({
    joined,
    spawns: planSpawn.mock.calls.length,
    listed: listed['sessions'],
  }).toMatchObject({
    joined: { restored: 3 },
    spawns: 1,
    listed: [{ id: 's-a' }, { id: 's-b' }, { id: 's-c' }],
  });
});

test('it starts no queued session once the daemon stops while the stagger runs', async () => {
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] }));
  const settles: RestoreSettled[] = [];

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      await writeSeedFleet(
        paths.dbPath,
        ['s-a', 's-b'].map((id) =>
          buildMockFleetEntry({ sessionID: toSessionID(id), cwd: paths.dir }),
        ),
      );

      // The fake agent never reports it booted, and no cap ends the wait, so
      // the stagger holds on the first session until the daemon stops.
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

  expect({ settles, spawns: planSpawn.mock.calls.length }).toStrictEqual({
    settles: [{ restored: 2, outcome: 'stopped' }],
    spawns: 1,
  });
});

test('it spawns nothing for a fleet.restore after the automatic restore settled', async () => {
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] }));
  const clock = buildStubClock(0);
  const settles: RestoreSettled[] = [];

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      await writeSeedFleet(
        paths.dbPath,
        ['s-a', 's-b'].map((id) =>
          buildMockFleetEntry({ sessionID: toSessionID(id), cwd: paths.dir }),
        ),
      );

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

  expect({ again, spawns: planSpawn.mock.calls.length }).toStrictEqual({
    again: { restored: 0 },
    spawns: 2,
  });
});

test('it restores the rest of the fleet past rows whose repository cannot be resolved', async () => {
  const locked = await mkdtemp(join(tmpdir(), 'atc-daemon-fleet-locked-'));

  const clock = buildStubClock(0);
  const settles: RestoreSettled[] = [];

  onTestFinished(async () => {
    await chmod(locked, 0o700);
    await rm(locked, { recursive: true, force: true });
  });

  await mkdir(join(locked, 'work'));
  await chmod(locked, 0o000);

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      await writeSeedFleet(paths.dbPath, [
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

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      await writeSeedFleet(paths.dbPath, [
        buildMockFleetEntry({
          sessionID: toSessionID('s-cloud'),
          cwd: join(paths.dir, 'cloud-main'),
          target: 'cloud',
          exited: true,
        }),
      ]);

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

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      const worktree = await createWorktree(paths.dir);

      await writeSeedFleet(paths.dbPath, [
        buildMockFleetEntry({ sessionID: toSessionID('s-wt'), cwd: worktree, exited: true }),
      ]);

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

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      const worktree = await createWorktree(paths.dir);

      await writeSeedFleet(paths.dbPath, [
        buildMockFleetEntry({ sessionID: toSessionID('s-wt'), cwd: worktree, exited: true }),
      ]);

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

// Seeds the daemon's database with a stored fleet and closes it before the
// daemon opens the same file.
async function writeSeedFleet(dbPath: string, entries: readonly FleetEntry[]): Promise<void> {
  const seed = await StateStore.open(dbPath);

  try {
    await seed.writeFleet(entries);
  } finally {
    await seed.stop();
  }
}

// A linked worktree at `wt` under the directory, whose repository is `main`
// beside it.
async function createWorktree(dir: string): Promise<string> {
  const worktree = join(dir, 'wt');

  await mkdir(worktree);

  await Bun.write(join(worktree, '.git'), `gitdir: ${dir}/main/.git/worktrees/wt\n`);

  return worktree;
}
