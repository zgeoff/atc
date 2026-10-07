import { expect, test } from 'bun:test';
import { verifyRestoredFleet } from './verify-restored-fleet';

function setupTest() {
  const lists: Readonly<Record<string, unknown>>[] = [];

  // A daemon that accepts the restore and answers one session list for each
  // reply the test queues, then never answers again.
  const client = {
    sendRequest: (m: string): Promise<Readonly<Record<string, unknown>>> => {
      const reply = m === 'fleet.restore' ? {} : lists.shift();

      return reply === undefined ? new Promise(() => {}) : Promise.resolve(reply);
    },
  };

  return { client, lists };
}

test('it reports the last answered list when the deadline overtakes a later list', async () => {
  const ctx = setupTest();

  ctx.lists.push({
    sessions: [
      { id: 's-good', kind: 'pty', alive: true, state: 'running', lastMsg: null },
      { id: 's-dropped', kind: 'stub', alive: false, state: 'running', lastMsg: 'no adapter' },
    ],
  });

  const verdict = await verifyRestoredFleet(ctx.client, 0.05, [
    { id: 's-good', name: 'good', exited: false, agentSessionID: null },
    { id: 's-dropped', name: 'dropped', exited: false, agentSessionID: null },
  ]);

  expect(verdict).toStrictEqual({
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

test('it rejects when the first list gets no answer before the deadline', () => {
  const ctx = setupTest();

  const verdict = verifyRestoredFleet(ctx.client, 0.05, [
    { id: 's-good', name: 'good', exited: false, agentSessionID: null },
  ]);

  expect(verdict).rejects.toThrowWithMessage(
    Error,
    'the new daemon stopped answering before the restore deadline',
  );
});
