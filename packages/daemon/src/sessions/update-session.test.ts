import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { toSessionID } from '@atc/core';
import { StateStore } from '@atc/store';
import { registerTestCleanup, setupTempDir, waitFor } from '@atc/test-utils';
import { buildMockSession } from '../testing/build-mock-session';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { PublishedRecords } from './published-records';
import { updateSession } from './update-session';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-update-session-');

  const store = await StateStore.open(join(temporaryDirectory.path, 'atc.db'));

  registerTestCleanup(() => store.stop());

  const records = new PublishedRecords({
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
