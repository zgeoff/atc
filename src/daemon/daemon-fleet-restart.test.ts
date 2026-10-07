import { expect, mock, onTestFinished, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';

test('it restores the stored sessions by itself after a restart', async () => {
  await using daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      onTestFinished(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: paths.dir }),
        buildMockFleetEntry({ sessionID: toSessionID('s-b'), cwd: paths.dir }),
      ]);

      return {
        adapter: buildMockAgentAdapter({ takesMessages: true }),
        restoreFleetOnRestart: true,
        restoreBootTimeoutMs: 10,
      };
    },
  });

  await waitFor(async () => {
    const listed = await daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toMatchObject([
      { id: 's-a', alive: true },
      { id: 's-b', alive: true },
    ]);
  });
});

test('it sends no message to the sessions it restores after a restart', async () => {
  await using daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      onTestFinished(() => seed.stop());

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

      return {
        adapter: buildMockAgentAdapter({ takesMessages: true }),
        restoreFleetOnRestart: true,
        restoreBootTimeoutMs: 10,
      };
    },
  });

  await waitFor(() => {
    expect(daemon.logs).toContain('atc fleet event=restore_settled restored=2');
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

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      onTestFinished(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: paths.dir }),
      ]);

      return {
        adapter: buildMockAgentAdapter({ planSpawn }),
        restoreBootTimeoutMs: 10,
      };
    },
  });

  await waitFor(() => {
    expect(daemon.logs).toContain('atc fleet event=restore_skipped stored=1');
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect({ sessions: listed['sessions'], spawns: planSpawn.mock.calls }).toStrictEqual({
    sessions: [],
    spawns: [],
  });
});

test('it restores the stored sessions on fleet.restore when the option is unset', async () => {
  await using daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      onTestFinished(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: paths.dir }),
      ]);

      return {
        adapter: buildMockAgentAdapter(),
        restoreBootTimeoutMs: 10,
      };
    },
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const listed = await daemon.client.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([{ id: 's-a', alive: true }]);
});

test('it starts none of the stored sessions when the option is false', async () => {
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] }));

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      onTestFinished(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-a'), cwd: paths.dir }),
      ]);

      return {
        adapter: buildMockAgentAdapter({ planSpawn }),
        restoreFleetOnRestart: false,
        restoreBootTimeoutMs: 10,
      };
    },
  });

  await waitFor(() => {
    expect(daemon.logs).toContain('atc fleet event=restore_skipped stored=1');
  });

  const listed = await daemon.client.sendRequest('session.list');

  expect({ sessions: listed['sessions'], spawns: planSpawn.mock.calls }).toStrictEqual({
    sessions: [],
    spawns: [],
  });
});

test('it joins a fleet.restore to the automatic restore while its stagger runs', async () => {
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] }));

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      onTestFinished(() => seed.stop());

      await seed.writeFleet(
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

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      onTestFinished(() => seed.stop());

      await seed.writeFleet(
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
      };
    },
  });

  await waitFor(() => {
    expect(planSpawn).toHaveBeenCalledOnce();
  });

  await daemon.stop();

  // The stopped restore settles once it has decided what else to start.
  await waitFor(() => {
    expect(daemon.logs).toContain('atc fleet event=restore_settled restored=2');
  });

  expect(planSpawn).toHaveBeenCalledOnce();
});

test('it spawns nothing for a fleet.restore after the automatic restore settled', async () => {
  const planSpawn = mock(() => ({ bin: 'sleep', args: ['30'] }));

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      onTestFinished(() => seed.stop());

      await seed.writeFleet(
        ['s-a', 's-b'].map((id) =>
          buildMockFleetEntry({ sessionID: toSessionID(id), cwd: paths.dir }),
        ),
      );

      return {
        adapter: buildMockAgentAdapter({ planSpawn }),
        restoreFleetOnRestart: true,
        restoreBootTimeoutMs: 10,
      };
    },
  });

  await waitFor(() => {
    expect(daemon.logs).toContain('atc fleet event=restore_settled restored=2');
  });

  const again = await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  expect({ again, spawns: planSpawn.mock.calls.length }).toStrictEqual({
    again: { restored: 0 },
    spawns: 2,
  });
});

test('it restores the rest of the fleet past rows whose repository cannot be resolved', async () => {
  const locked = await mkdtemp(join(tmpdir(), 'atc-daemon-fleet-locked-'));

  onTestFinished(async () => {
    await chmod(locked, 0o700);
    await rm(locked, { recursive: true, force: true });
  });

  await mkdir(join(locked, 'work'));
  await chmod(locked, 0o000);

  await using daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      onTestFinished(() => seed.stop());

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

      return {
        adapter: buildMockAgentAdapter(),
        restoreFleetOnRestart: true,
        restoreBootTimeoutMs: 10,
      };
    },
  });

  await waitFor(() => {
    expect(daemon.logs).toContain('atc fleet event=restore_settled restored=5');
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
  await using daemon = await startTestDaemon({
    options: async (paths) => {
      const seed = await StateStore.open(paths.dbPath);

      onTestFinished(() => seed.stop());

      await seed.writeFleet([
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
        restoreBootTimeoutMs: 10,
      };
    },
  });

  await waitFor(() => {
    expect(daemon.logs).toContain('atc fleet event=restore_settled restored=1');
  });

  await daemon.client.sendRequest('session.forget', { session: 's-cloud' });

  const after = await daemon.client.sendRequest('session.list');

  expect(after['sessions']).toStrictEqual([]);
});

test('it regroups a revived exited worktree session under its repository', async () => {
  await using daemon = await startTestDaemon({
    options: async (paths) => {
      const worktree = join(paths.dir, 'wt');

      await mkdir(worktree);

      await Bun.write(join(worktree, '.git'), `gitdir: ${paths.dir}/main/.git/worktrees/wt\n`);

      const seed = await StateStore.open(paths.dbPath);

      onTestFinished(() => seed.stop());

      await seed.writeFleet([
        buildMockFleetEntry({ sessionID: toSessionID('s-wt'), cwd: worktree, exited: true }),
      ]);

      return {
        adapter: buildMockAgentAdapter(),
        restoreFleetOnRestart: true,
        restoreBootTimeoutMs: 10,
      };
    },
  });

  await waitFor(() => {
    expect(daemon.logs).toContain('atc fleet event=restore_settled restored=1');
  });

  await daemon.client.sendRequest('session.adopt', { session: 's-wt', cols: 80, rows: 24 });

  const after = await daemon.client.sendRequest('session.list');

  expect(after['sessions']).toMatchObject([
    { id: 's-wt', alive: true, repoRoot: join(daemon.dir, 'main') },
  ]);
});
