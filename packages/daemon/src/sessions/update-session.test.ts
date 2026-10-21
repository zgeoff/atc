import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { toSessionID } from '@atc/core';
import { createStateStore } from '@atc/store';
import { registerTestCleanup, setupTempDir, waitFor } from '@atc/test-utils';
import { buildMockSession } from '../testing/build-mock-session';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { buildRecordSubject } from './build-record-subject';
import { createPublishedRecords } from './create-published-records';
import { updateSession } from './update-session';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-update-session-');

  const store = await createStateStore(join(temporaryDirectory.path, 'atc.db'));

  registerTestCleanup(() => store.stop());

  const records = createPublishedRecords({
    store,
    daemonID: store.daemonID,
    localDir: join(temporaryDirectory.path, 'records'),
    ghBin: 'gh',
    now: () => Date.parse('2026-10-08T09:30:00.000Z'),
  });

  const provider = buildStubMemoryProvider({ kind: 'box', remote: true });

  const fleet = {
    emitChange: () => {},
    tryWriteFleet: () => Promise.resolve(true),
    writeStatus: () => {},
  };

  return { store, records, provider, fleet };
}

test('it places the record copy on a remote host without a host lifecycle when a person renames the session', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({
    id: toSessionID('s-remote'),
    name: 'login fix',
    target: 'box',
    cwd: '/work/app',
    vm: 'none',
  });

  await ctx.records.createRecord(
    {
      session: session.id,
      target: 'box',
      name: 'login fix',
      transcriptPath: null,
      provider: ctx.provider,
      host: session.hostKey,
      directory: '/work/app',
      workspace: null,
    },
    null,
  );

  updateSession(
    {
      registry: {
        sessions: [session],
        requireExecution: () => ({ provider: ctx.provider, identity: 'test:box' }),
      },
      fleet: ctx.fleet,
      callbacks: { onEvent: () => {}, findRecords: () => ctx.records, log: () => {} },
    },
    session.id,
    { name: 'cart rework' },
  );

  const placed = await waitFor(() => {
    const last = ctx.provider.commands.at(-1);

    expect(ctx.provider.commands).toHaveLength(2);

    return last;
  });

  expect(placed?.argv.at(-1)).toInclude('"name": "cart rework"');
});

test('it stores a rename of a session whose remote host sleeps and places the copy at the next harness start', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({
    id: toSessionID('s-asleep'),
    name: 'login fix',
    target: 'box',
    cwd: '/work/app',
    vm: 'asleep',
  });

  await ctx.records.createRecord(
    {
      session: session.id,
      target: 'box',
      name: 'login fix',
      transcriptPath: null,
      provider: ctx.provider,
      host: session.hostKey,
      directory: '/work/app',
      workspace: null,
    },
    null,
  );

  updateSession(
    {
      registry: {
        sessions: [session],
        requireExecution: () => ({ provider: ctx.provider, identity: 'test:box' }),
      },
      fleet: ctx.fleet,
      callbacks: { onEvent: () => {}, findRecords: () => ctx.records, log: () => {} },
    },
    session.id,
    { name: 'cart rework' },
  );

  await waitFor(async () => {
    const stored = await ctx.store.readPublishedRecord(session.id);

    expect(stored?.name).toBe('cart rework');
  });

  const commandsWhileAsleep = ctx.provider.commands.length;

  await ctx.records.restoreCopy(buildRecordSubject(session, ctx.provider));

  expect(commandsWhileAsleep).toBe(1);
  expect(ctx.provider.commands).toHaveLength(2);
  expect(ctx.provider.commands.at(-1)?.argv.at(-1)).toInclude('"name": "cart rework"');
});
