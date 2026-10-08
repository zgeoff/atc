import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from './client/daemon-client';
import { toSessionID } from './shared/to-session-id';
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

  ctx.daemon.lists.push({
    sessions: [
      buildMockSessionDescriptor({ id: toSessionID('s-good'), kind: 'pty', alive: true }),
      buildMockSessionDescriptor({
        id: toSessionID('s-dropped'),
        kind: 'headless',
        alive: false,
        state: 'running',
        lastMsg: 'no adapter',
      }),
    ],
  });

  const verdict = verifyRestoredFleet(
    ctx.client,
    1,
    [
      buildMockStoredRow({ id: 's-good', name: 'good' }),
      buildMockStoredRow({ id: 's-dropped', name: 'dropped' }),
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
    expect(ctx.daemon.methods).toStrictEqual(['fleet.restore', 'session.list', 'session.list']);
    expect(clock.collectPending()).toStrictEqual([750]);
  });

  clock.advance(750);

  const outcome = await verdict;

  expect(outcome).toStrictEqual({
    total: 2,
    failed: [
      {
        name: 'dropped',
        id: 's-dropped',
        reason: 'listed in state running without a terminal: no adapter',
      },
    ],
  });
});

test('it rejects when the first list gets no answer before the deadline', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  const verdict = verifyRestoredFleet(
    ctx.client,
    1,
    [buildMockStoredRow({ id: 's-good', name: 'good' })],
    clock,
  );

  await waitFor(() => {
    expect(ctx.daemon.methods).toStrictEqual(['fleet.restore', 'session.list']);
    expect(clock.collectPending()).toStrictEqual([1000]);
  });

  clock.advance(1000);

  expect(verdict).rejects.toThrowWithMessage(
    Error,
    'the new daemon stopped answering before the restore deadline',
  );
});
