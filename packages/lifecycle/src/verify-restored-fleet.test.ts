import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { buildMockStoredRow } from '@atc/store/testing';
import {
  buildMockListedAgent,
  buildMockSessionDescriptor,
  buildStubClock,
  registerTestCleanup,
  setupTempDir,
  startStubRestoreDaemon,
  waitFor,
} from '@atc/test-utils';
import { toAgentSessionID, toSessionID } from '@atcx/contract';
import { verifyRestoredFleet } from './verify-restored-fleet';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-verify-restored-fleet-');
  const daemon = startStubRestoreDaemon(join(temporaryDirectory.path, 'daemon.sock'));

  const client = await openDaemonClient(join(temporaryDirectory.path, 'daemon.sock'));

  registerTestCleanup(() => {
    client.stop();
  });

  return { daemon, client };
}

test('it reports the last answered list when the deadline overtakes a later list', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  ctx.daemon.lists.push(
    { agents: [buildMockListedAgent({ id: 'claude' })] },
    {
      sessions: [
        buildMockSessionDescriptor({ id: toSessionID('s-good'), kind: 'pty', alive: true }),
        buildMockSessionDescriptor({
          id: toSessionID('s-booting'),
          agent: 'claude',
          kind: 'headless',
          alive: false,
          state: 'running',
          lastMsg: 'booting',
        }),
      ],
    },
  );

  const verdict = verifyRestoredFleet(ctx.client, {
    timeoutSeconds: 1,
    snapshot: [
      buildMockStoredRow({ id: 's-good', name: 'good' }),
      buildMockStoredRow({ id: 's-booting', name: 'booting' }),
    ],
    clock,
    restoreBootTimeoutMs: 15_000,
  });

  // The first list answers with a row still without a terminal, so the
  // check waits a poll interval before it lists again.
  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([250]);
  });

  clock.advance(250);

  // The daemon withholds the second list, which only the deadline ends.
  await waitFor(() => {
    expect(ctx.daemon.methods).toStrictEqual([
      'fleet.restore',
      'agents.list',
      'session.list',
      'session.list',
    ]);

    expect(clock.collectPending()).toStrictEqual([750]);
  });

  clock.advance(750);

  const outcome = await verdict;

  expect(outcome).toStrictEqual({
    total: 2,
    failed: [
      {
        name: 'booting',
        id: 's-booting',
        reason: 'listed in state running without a terminal: booting',
      },
    ],
  });
});

test('it fails a row at once when its agent is not in the config', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  ctx.daemon.lists.push(
    { agents: [buildMockListedAgent({ id: 'claude' })] },
    {
      sessions: [
        buildMockSessionDescriptor({ id: toSessionID('s-good'), kind: 'pty', alive: true }),
        buildMockSessionDescriptor({
          id: toSessionID('s-dropped'),
          agent: 'dropped-backend',
          kind: 'headless',
          alive: false,
          state: 'running',
          lastMsg: "no adapter for 'dropped-backend'",
        }),
      ],
    },
  );

  const outcome = await verifyRestoredFleet(ctx.client, {
    timeoutSeconds: 60,
    snapshot: [
      buildMockStoredRow({ id: 's-good', name: 'good' }),
      buildMockStoredRow({ id: 's-dropped', name: 'dropped' }),
    ],
    clock,
    restoreBootTimeoutMs: 15_000,
  });

  expect(outcome).toStrictEqual({
    total: 2,
    failed: [
      {
        name: 'dropped',
        id: 's-dropped',
        reason: "listed in state running without a terminal: no adapter for 'dropped-backend'",
      },
    ],
  });

  expect(ctx.daemon.methods).toStrictEqual(['fleet.restore', 'agents.list', 'session.list']);
});

test('it fails a stored row that only a session with another id shares an agent session with', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  ctx.daemon.lists.push(
    {
      fleet: [
        {
          sessionID: 's-old',
          name: 'old',
          cwd: '/work',
          agent: 'claude',
          exited: false,
          agentSessionID: 'a-1',
        },
      ],
    },
    { agents: [buildMockListedAgent({ id: 'claude' })] },
    {
      sessions: [
        buildMockSessionDescriptor({
          id: toSessionID('s-other'),
          agentSessionID: toAgentSessionID('a-1'),
          kind: 'pty',
          alive: true,
        }),
      ],
    },
  );

  const outcome = await verifyRestoredFleet(ctx.client, {
    timeoutSeconds: 60,
    snapshot: null,
    clock,
    restoreBootTimeoutMs: 15_000,
  });

  expect(outcome).toStrictEqual({
    total: 1,
    failed: [{ name: 'old', id: 's-old', reason: 'not listed after the restore' }],
  });
});

test('it fails a row at once with its refusal when its restore was refused for good', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  ctx.daemon.lists.push(
    { agents: [buildMockListedAgent({ id: 'claude' })] },
    {
      sessions: [
        buildMockSessionDescriptor({ id: toSessionID('s-good'), kind: 'pty', alive: true }),
        buildMockSessionDescriptor({
          id: toSessionID('s-refused'),
          agent: 'claude',
          kind: 'headless',
          alive: false,
          state: 'running',
          lastMsg: 'the auth profiles host s-refused uses changed since it was bound',
          restoreRefusal: 'auth_rebind_required',
        }),
      ],
    },
  );

  const outcome = await verifyRestoredFleet(ctx.client, {
    timeoutSeconds: 60,
    snapshot: [
      buildMockStoredRow({ id: 's-good', name: 'good' }),
      buildMockStoredRow({ id: 's-refused', name: 'refused' }),
    ],
    clock,
    restoreBootTimeoutMs: 15_000,
  });

  expect(outcome).toStrictEqual({
    total: 2,
    failed: [
      {
        name: 'refused',
        id: 's-refused',
        reason:
          'restore refused (auth_rebind_required): the auth profiles host s-refused uses changed since it was bound',
      },
    ],
  });

  expect(ctx.daemon.methods).toStrictEqual(['fleet.restore', 'agents.list', 'session.list']);
});

test('it keeps waiting on a row whose agent is in the config but not installed yet', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  ctx.daemon.lists.push(
    {
      agents: [
        buildMockListedAgent({ id: 'claude', installed: false }),
        buildMockListedAgent({ id: 'codex', installed: false }),
      ],
    },
    {
      sessions: [
        buildMockSessionDescriptor({
          id: toSessionID('s-installing'),
          agent: 'codex',
          kind: 'headless',
          alive: false,
          state: 'running',
          lastMsg: 'installing',
        }),
      ],
    },
  );

  const verdict = verifyRestoredFleet(ctx.client, {
    timeoutSeconds: 60,
    snapshot: [buildMockStoredRow({ id: 's-installing', name: 'installing' })],
    clock,
    restoreBootTimeoutMs: 15_000,
  });

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([250]);
  });

  ctx.daemon.lists.push({
    sessions: [
      buildMockSessionDescriptor({
        id: toSessionID('s-installing'),
        agent: 'codex',
        kind: 'pty',
        alive: true,
      }),
    ],
  });

  clock.advance(250);

  const outcome = await verdict;

  expect(outcome).toStrictEqual({ total: 1, failed: [] });
});

test('it keeps waiting on every row when the daemon refuses the agent list', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  ctx.daemon.unknown.add('agents.list');

  ctx.daemon.lists.push({
    sessions: [
      buildMockSessionDescriptor({
        id: toSessionID('s-dropped'),
        agent: 'dropped-backend',
        kind: 'headless',
        alive: false,
        state: 'running',
        lastMsg: "no adapter for 'dropped-backend'",
      }),
    ],
  });

  const verdict = verifyRestoredFleet(ctx.client, {
    timeoutSeconds: 1,
    snapshot: [buildMockStoredRow({ id: 's-dropped', name: 'dropped' })],
    clock,
    restoreBootTimeoutMs: 15_000,
  });

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([250]);
  });

  clock.advance(250);

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([750]);
  });

  clock.advance(750);

  const outcome = await verdict;

  expect(outcome).toStrictEqual({
    total: 1,
    failed: [
      {
        name: 'dropped',
        id: 's-dropped',
        reason: "listed in state running without a terminal: no adapter for 'dropped-backend'",
      },
    ],
  });
});

test('it keeps waiting on every row when the agent list answer holds no agents', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  ctx.daemon.lists.push(
    {},
    {
      sessions: [
        buildMockSessionDescriptor({
          id: toSessionID('s-booting'),
          agent: 'claude',
          kind: 'headless',
          alive: false,
          state: 'running',
          lastMsg: 'booting',
        }),
      ],
    },
  );

  const verdict = verifyRestoredFleet(ctx.client, {
    timeoutSeconds: 60,
    snapshot: [buildMockStoredRow({ id: 's-booting', name: 'booting' })],
    clock,
    restoreBootTimeoutMs: 15_000,
  });

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([250]);
  });

  ctx.daemon.lists.push({
    sessions: [
      buildMockSessionDescriptor({ id: toSessionID('s-booting'), kind: 'pty', alive: true }),
    ],
  });

  clock.advance(250);

  const outcome = await verdict;

  expect(outcome).toStrictEqual({ total: 1, failed: [] });
});

test('it lists the rows within the deadline when the agent list gets no answer', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  const verdict = verifyRestoredFleet(ctx.client, {
    timeoutSeconds: 60,
    snapshot: [buildMockStoredRow({ id: 's-good', name: 'good' })],
    clock,
    restoreBootTimeoutMs: 15_000,
  });

  // Nothing is queued, so the daemon withholds the agent list, which only
  // its own time limit ends.
  await waitFor(() => {
    expect(ctx.daemon.methods).toStrictEqual(['fleet.restore', 'agents.list']);
    expect(clock.collectPending()).toStrictEqual([5000]);
  });

  ctx.daemon.lists.push({
    sessions: [buildMockSessionDescriptor({ id: toSessionID('s-good'), kind: 'pty', alive: true })],
  });

  clock.advance(5000);

  const outcome = await verdict;

  expect(outcome).toStrictEqual({ total: 1, failed: [] });
});

test('it rejects when the first list gets no answer before the deadline', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  ctx.daemon.lists.push({
    agents: [buildMockListedAgent({ id: 'claude' })],
  });

  const verdict = verifyRestoredFleet(ctx.client, {
    timeoutSeconds: 1,
    snapshot: [buildMockStoredRow({ id: 's-good', name: 'good' })],
    clock,
    restoreBootTimeoutMs: 15_000,
  });

  await waitFor(() => {
    expect(ctx.daemon.methods).toStrictEqual(['fleet.restore', 'agents.list', 'session.list']);
    expect(clock.collectPending()).toStrictEqual([1000]);
  });

  clock.advance(1000);

  expect(verdict).rejects.toThrowWithMessage(
    Error,
    'the new daemon stopped answering before the restore deadline',
  );
});
