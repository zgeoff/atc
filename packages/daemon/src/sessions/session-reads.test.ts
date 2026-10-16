import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { toAgentSessionID, toSessionID } from '@atc/core';
import type { AgentAdapter } from '@atc/plugin-api';
import { StateStore } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/testing';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { TargetAccess } from '../auth/target-access';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { PublishedRecords } from './published-records';
import { SessionReads } from './session-reads';
import { SessionManager } from './sessions';

interface SetupTestConfig {
  // The one agent the sessions run.
  readonly adapter: AgentAdapter;
}

// A session manager on one `local` target over the in-memory provider, a
// real state store and published records, and the reads over them.
async function setupTest(config: SetupTestConfig) {
  const tmp = setupTempDir('atc-session-reads-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const mgr = new SessionManager(
    null,
    store,
    join(tmp.dir, 'status.json'),
    [config.adapter],
    [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
    ],
    [],
    {},
  );

  registerTestCleanup(() => {
    mgr.detachAll();
  });

  const records = new PublishedRecords({
    store,
    daemonID: store.daemonID,
    localDir: join(tmp.dir, 'records'),
    ghBin: 'gh',
    now: () => 1_000_000,
  });

  const reads = new SessionReads({ mgr, store, records });

  return { dir: tmp.dir, store, mgr, reads };
}

test('it reads the record of a session with the time of its last trail row', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', 'tidy the docs', 80, 24);

  await ctx.store.recordEvent({ atcId: s.id, event: 'Stop', payload: {} }, null, 1_700_000_000_000);

  const record = await ctx.reads.readSessionRecord(s.id, null);

  expect(record).toMatchObject({
    session: { id: s.id, name: 'worker' },
    prompt: 'tidy the docs',
    lastActivityAt: 1_700_000_000_000,
    pending: null,
    result: null,
    sessionRecord: null,
  });
});

test('it reads the creation time as the last activity of a session with no trail rows', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);
  const record = await ctx.reads.readSessionRecord(s.id, null);

  expect(record).toMatchObject({ lastActivityAt: s.createdAt });
});

test('it reads the message a session waits on as pending', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  ctx.mgr.updateAttention(s.id, 'needs_you', 'Allow the edit?');

  const record = await ctx.reads.readSessionRecord(s.id, null);

  expect(record).toMatchObject({ pending: { message: 'Allow the edit?' } });
});

test('it counts the trail rows of the agent session the session resumed', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  s.agentSessionID = toAgentSessionID('a-1');

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-earlier'), event: 'Stop', payload: { session_id: 'a-1' } },
    null,
    1_700_000_000_000,
  );

  const record = await ctx.reads.readSessionRecord(s.id, null);

  expect(record).toMatchObject({ lastActivityAt: 1_700_000_000_000 });
});

test('it counts only the own trail rows of the session under an access', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  s.agentSessionID = toAgentSessionID('a-1');

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-earlier'), event: 'Stop', payload: { session_id: 'a-1' } },
    null,
    1_700_000_000_000,
  );

  const access = new TargetAccess([{ target: 'local', targetIdentity: 'local-pty:test' }]);

  const record = await ctx.reads.readSessionRecord(s.id, access);

  expect(record).toMatchObject({ lastActivityAt: s.createdAt });
});

test('it reads no record for a session the manager does not hold', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const record = await ctx.reads.readSessionRecord(toSessionID('s-gone'), null);

  expect(record).toBe('missing');
});

test('it pages the transcript of a session through its agent', async () => {
  const ctx = await setupTest({
    adapter: {
      ...buildStubHarnessAdapter(),
      parseTranscriptLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    },
  });

  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);

  const path = join(ctx.dir, 'transcript.jsonl');

  await Bun.write(path, 'first turn\nsecond turn\n');

  s.transcriptPath = path;

  const read = await ctx.reads.loadSessionTranscript(s.id, null, 10);

  expect(read).toMatchObject({
    path,
    page: {
      rows: [
        { role: 'user', text: 'first turn', tools: [], at: null },
        { role: 'user', text: 'second turn', tools: [], at: null },
      ],
      more: false,
    },
  });
});

test('it reads an empty page for a session with no transcript yet', async () => {
  const ctx = await setupTest({
    adapter: {
      ...buildStubHarnessAdapter(),
      parseTranscriptLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    },
  });

  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);
  const read = await ctx.reads.loadSessionTranscript(s.id, null, 10);

  expect(read).toStrictEqual({ path: '', page: { rows: [], offset: 0, more: false } });
});

test('it refuses a transcript read for an agent that parses none', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const s = await ctx.mgr.spawn(ctx.dir, 'worker', '', 80, 24);
  const read = await ctx.reads.loadSessionTranscript(s.id, null, 10);

  expect(read).toBe('unsupported');
});

test('it refuses a transcript read for a session the manager does not hold', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const read = await ctx.reads.loadSessionTranscript(toSessionID('s-gone'), null, 10);

  expect(read).toBe('missing');
});
