import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/test-utils';
import { openTestEventDatabase } from '../testing/open-test-event-database';
import { readCallbackVerifiedAt } from './read-callback-verified-at';
import { writeCallbackVerifiedAt } from './write-callback-verified-at';

async function setupTest() {
  const store = await openTestEventDatabase();

  registerTestCleanup(() => store.close());

  return { db: store.db };
}

test("it records when a client's callback URL was verified", async () => {
  const ctx = await setupTest();

  await writeCallbackVerifiedAt(ctx.db, {
    clientID: 'client-one',
    url: 'https://hooks.example.com/hook',
    now: Date.UTC(2026, 9, 23, 12, 0, 0),
  });

  const verifiedAt = await readCallbackVerifiedAt(
    ctx.db,
    'client-one',
    'https://hooks.example.com/hook',
  );

  expect(verifiedAt).toBe('2026-10-23T12:00:00.000Z');
});

test('it moves the verified time of a callback URL verified again', async () => {
  const ctx = await setupTest();

  await writeCallbackVerifiedAt(ctx.db, {
    clientID: 'client-one',
    url: 'https://hooks.example.com/hook',
    now: Date.UTC(2026, 9, 23, 12, 0, 0),
  });

  await writeCallbackVerifiedAt(ctx.db, {
    clientID: 'client-one',
    url: 'https://hooks.example.com/hook',
    now: Date.UTC(2026, 9, 30, 12, 0, 0),
  });

  const verifiedAt = await readCallbackVerifiedAt(
    ctx.db,
    'client-one',
    'https://hooks.example.com/hook',
  );

  expect(verifiedAt).toBe('2026-10-30T12:00:00.000Z');
});
