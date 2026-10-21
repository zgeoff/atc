import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { toSessionID } from '@atc/core';
import { createStateStore } from '@atc/store';
import {
  buildMockFleetEntry,
  buildMockIdempotencyRecord,
  createMigratedStateDB,
} from '@atc/store/testing';
import { buildMockSessionDescriptor, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { buildTargetAccessFromGrants } from '../auth/build-target-access-from-grants';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createSessionManager } from './create-session-manager';
import { createSpawnReplay } from './create-spawn-replay';

// A session manager on one `local` target over the in-memory provider, a
// real state store, and the replay that reads both.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-spawn-replay-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const manager = createSessionManager(
    null,
    store,
    join(temporaryDirectory.path, 'status.json'),
    [buildStubHarnessAdapter()],
    [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
  );

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const replay = createSpawnReplay({ manager, store });

  return { store, manager, replay };
}

test('it answers with the listed session as it stands now', async () => {
  const ctx = await setupTest();

  ctx.manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-1'),
      name: 'renamed since',
      target: 'local',
      targetIdentity: 'local-pty:test',
    }),
  );

  const stored = { session: buildMockSessionDescriptor({ name: 'first name' }) };

  const record = buildMockIdempotencyRecord({
    operation: 'session.spawn',
    effectRef: 's-1',
    result: JSON.stringify(stored),
  });

  const answer = await ctx.replay.loadReplay(record, null);

  expect(answer.session).toMatchObject({ id: 's-1', name: 'renamed since' });
});

test('it answers with the stored answer when the session is not listed', async () => {
  const ctx = await setupTest();

  const stored = { session: buildMockSessionDescriptor({ id: toSessionID('s-1') }) };

  const answer = await ctx.replay.loadReplay(
    buildMockIdempotencyRecord({
      operation: 'session.spawn',
      effectRef: 's-1',
      result: JSON.stringify(stored),
    }),
    null,
  );

  expect(answer).toStrictEqual(stored);
});

test('it refuses a replay whose session is neither listed nor stored as no such session', async () => {
  const ctx = await setupTest();

  const replayed = ctx.replay.loadReplay(
    buildMockIdempotencyRecord({ operation: 'session.spawn', effectRef: 's-1', result: null }),
    null,
  );

  expect(replayed).rejects.toMatchObject({
    code: 'no_such_session',
    data: { effectRef: 's-1' },
  });
});

test('it answers a replay whose session the access reaches', async () => {
  const ctx = await setupTest();

  ctx.manager.restore(
    buildMockFleetEntry({
      sessionID: toSessionID('s-1'),
      target: 'local',
      targetIdentity: 'local-pty:test',
    }),
  );

  const answer = await ctx.replay.loadReplay(
    buildMockIdempotencyRecord({
      operation: 'session.spawn',
      effectRef: 's-1',
      effectTarget: { target: 'local', targetIdentity: 'local-pty:test' },
    }),
    buildTargetAccessFromGrants([{ target: 'local', targetIdentity: 'local-pty:test' }]),
  );

  expect(answer.session.id).toBe(toSessionID('s-1'));
});

test('it refuses a replay under an access when the key holds no target, naming the stored one', async () => {
  const ctx = await setupTest();

  const stored = {
    session: buildMockSessionDescriptor({
      id: toSessionID('s-1'),
      locator: { targetID: 'remote' },
    }),
  };

  const record = buildMockIdempotencyRecord({
    operation: 'session.spawn',
    effectRef: 's-1',
    effectTarget: null,
    result: JSON.stringify(stored),
  });

  const replayed = ctx.replay.loadReplay(
    record,
    buildTargetAccessFromGrants([{ target: 'local', targetIdentity: 'local-pty:test' }]),
  );

  expect(replayed).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'remote' } });
});

test('it refuses a replay whose target the access may not use', async () => {
  const ctx = await setupTest();

  const replayed = ctx.replay.loadReplay(
    buildMockIdempotencyRecord({
      operation: 'session.spawn',
      effectRef: 's-1',
      effectTarget: { target: 'local', targetIdentity: 'local-pty:test' },
    }),
    buildTargetAccessFromGrants([{ target: 'local', targetIdentity: 'local-pty:other' }]),
  );

  expect(replayed).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'local' } });
});

test('it refuses a replay whose stored tree holds a session on a target the access may not use', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-lead'),
      target: 'remote',
      targetIdentity: 'imp:remote',
    }),
    buildMockFleetEntry({
      sessionID: toSessionID('s-1'),
      parent: toSessionID('s-lead'),
      target: 'local',
      targetIdentity: 'local-pty:test',
    }),
  ]);

  const stored = { session: buildMockSessionDescriptor({ id: toSessionID('s-1') }) };

  const record = buildMockIdempotencyRecord({
    operation: 'session.spawn',
    effectRef: 's-1',
    effectTarget: { target: 'local', targetIdentity: 'local-pty:test' },
    result: JSON.stringify(stored),
  });

  const replayed = ctx.replay.loadReplay(
    record,
    buildTargetAccessFromGrants([{ target: 'local', targetIdentity: 'local-pty:test' }]),
  );

  expect(replayed).rejects.toMatchObject({ code: 'target_forbidden', data: { target: 'local' } });
});
