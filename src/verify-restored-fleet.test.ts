import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from './client/daemon-client';
import { buildAgentList } from './daemon/build-agent-list';
import { toSessionID } from './shared/to-session-id';
import { buildMockAgentAdapter } from './test-utils/build-mock-agent-adapter';
import { buildMockSessionDescriptor } from './test-utils/build-mock-session-descriptor';
import { buildMockStoredRow } from './test-utils/build-mock-stored-row';
import { buildStubClock } from './test-utils/build-stub-clock';
import { registerTestCleanup } from './test-utils/register-test-cleanup';
import { setupTempDir } from './test-utils/setup-temp-dir';
import { startStubRestoreDaemon } from './test-utils/start-stub-restore-daemon';
import { waitFor } from './test-utils/wait-for';
import { verifyRestoredFleet } from './verify-restored-fleet';

async function setupTest() {
  const tmp = setupTempDir('atc-verify-restored-fleet-');
  const daemon = startStubRestoreDaemon(join(tmp.dir, 'daemon.sock'));

  const client = await DaemonClient.open(join(tmp.dir, 'daemon.sock'));

  registerTestCleanup(() => {
    client.stop();
  });

  return { daemon, client };
}

test('it reports the last answered list when the deadline overtakes a later list', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  ctx.daemon.lists.push(
    { agents: buildAgentList([buildMockAgentAdapter({ id: 'claude' })], () => true, false) },
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

  const verdict = verifyRestoredFleet(
    ctx.client,
    1,
    [
      buildMockStoredRow({ id: 's-good', name: 'good' }),
      buildMockStoredRow({ id: 's-booting', name: 'booting' }),
    ],
    clock,
  );

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
    { agents: buildAgentList([buildMockAgentAdapter({ id: 'claude' })], () => true, false) },
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

  const outcome = await verifyRestoredFleet(
    ctx.client,
    60,
    [
      buildMockStoredRow({ id: 's-good', name: 'good' }),
      buildMockStoredRow({ id: 's-dropped', name: 'dropped' }),
    ],
    clock,
  );

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

test('it keeps waiting on a row whose agent is in the config but not installed yet', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  // A mock adapter carries no profile, so the list shows each one as not
  // installed.
  ctx.daemon.lists.push(
    {
      agents: buildAgentList(
        [buildMockAgentAdapter({ id: 'claude' }), buildMockAgentAdapter({ id: 'codex' })],
        () => true,
        false,
      ),
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

  const verdict = verifyRestoredFleet(
    ctx.client,
    60,
    [buildMockStoredRow({ id: 's-installing', name: 'installing' })],
    clock,
  );

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

test('it keeps waiting on every row when the daemon predates the agent list', async () => {
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

  const verdict = verifyRestoredFleet(
    ctx.client,
    1,
    [buildMockStoredRow({ id: 's-dropped', name: 'dropped' })],
    clock,
  );

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

test('it lists the rows within the deadline when the agent list gets no answer', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  const verdict = verifyRestoredFleet(
    ctx.client,
    60,
    [buildMockStoredRow({ id: 's-good', name: 'good' })],
    clock,
  );

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
    agents: buildAgentList([buildMockAgentAdapter({ id: 'claude' })], () => true, false),
  });

  const verdict = verifyRestoredFleet(
    ctx.client,
    1,
    [buildMockStoredRow({ id: 's-good', name: 'good' })],
    clock,
  );

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
