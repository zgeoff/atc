import { expect, test } from 'bun:test';
import { buildStubClock, registerTestCleanup } from '@atc/test-utils';
import { openTestEventDatabase } from '../testing/open-test-event-database';
import { seedEventSubscription } from './seed-event-subscription';

async function setupTest() {
  const store = await openTestEventDatabase();

  registerTestCleanup(() => store.close());

  return { store, db: store.db, clock: buildStubClock(Date.UTC(2026, 9, 14, 12, 0, 0)) };
}

test('it writes a subscription created at the clock time and live for an hour', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.admin.clients.add('Claude', [
    'https://claude.ai/api/mcp/auth_callback',
  ]);

  await seedEventSubscription(ctx, { id: 'sub-one', client_id: created.clientID });

  expect(ctx.db.selectFrom('atc_event_subscription').selectAll().execute()).resolves.toMatchObject([
    {
      id: 'sub-one',
      client_id: created.clientID,
      created_at: '2026-10-14T12:00:00.000Z',
      refresh_before: '2026-10-14T13:00:00.000Z',
    },
  ]);
});

test('it writes the input over the defaults', async () => {
  const ctx = await setupTest();

  const created = await ctx.store.admin.clients.add('Claude', [
    'https://claude.ai/api/mcp/auth_callback',
  ]);

  await seedEventSubscription(ctx, {
    id: 'sub-one',
    client_id: created.clientID,
    url: 'https://hooks.example.com/hook',
    position: 'cursor-1',
    refresh_before: '2026-10-14T12:30:00.000Z',
  });

  expect(ctx.db.selectFrom('atc_event_subscription').selectAll().execute()).resolves.toMatchObject([
    {
      url: 'https://hooks.example.com/hook',
      position: 'cursor-1',
      refresh_before: '2026-10-14T12:30:00.000Z',
    },
  ]);
});
