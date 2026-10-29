import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter } from '@atc/plugin-api';
import { createStateStore } from '@atc/store';
import { createMigratedStateDB, registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { toAgentSessionID, toSessionID } from '@atcx/contract';
import { buildTargetAccessFromGrants } from '../auth/build-target-access-from-grants';
import { buildMockExecutionTarget } from '../testing/build-mock-execution-target';
import { buildStubGuestFilesProvider } from '../testing/build-stub-guest-files-provider';
import { buildStubHarnessAdapter } from '../testing/build-stub-harness-adapter';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { createPublishedRecords } from './create-published-records';
import { createSessionManager } from './create-session-manager';
import { createSessionReads } from './create-session-reads';

interface SetupTestConfig {
  // The one agent the sessions run.
  readonly adapter: AgentAdapter;
}

// A session manager on a `local` target over the in-memory provider and a
// `guest` target on a remote host whose files sit in a host folder, a real
// state store and published records, and the reads over them.
async function setupTest(config: SetupTestConfig) {
  const temporaryDirectory = setupTempDir('atc-session-reads-');
  const dbPath = join(temporaryDirectory.path, 'state.db');
  const guestFiles = join(temporaryDirectory.path, 'guest');

  createMigratedStateDB(dbPath);

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const manager = createSessionManager({
    fallback: null,
    store,
    statusPath: join(temporaryDirectory.path, 'status.json'),
    adapters: [config.adapter],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        identity: 'local-pty:test',
        provider: buildStubMemoryProvider({ kind: 'local-pty' }),
      }),
      buildMockExecutionTarget({
        id: 'guest',
        identity: 'remote:test',
        provider: buildStubGuestFilesProvider({
          guestDirectory: '/tmp/atc',
          hostDirectory: guestFiles,
        }),
      }),
    ],
  });

  registerTestCleanup(() => {
    manager.detachAll();
  });

  const records = createPublishedRecords({
    store,
    daemonID: store.daemonID,
    localDir: join(temporaryDirectory.path, 'records'),
    ghBin: 'gh',
    now: () => 1_000_000,
  });

  const reads = createSessionReads({ manager, store, records });

  return { directory: temporaryDirectory.path, guestFiles, store, manager, reads };
}

test('it reads the record of a session with the time of its last trail row', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: 'tidy the docs',
    cols: 80,
    rows: 24,
  });

  await ctx.store.recordEvent(
    { atcId: session.id, event: 'Stop', payload: {} },
    null,
    1_700_000_000_000,
  );

  const record = await ctx.reads.readSessionRecord(session.id, null);

  expect(record).toMatchObject({
    session: { id: session.id, name: 'worker' },
    prompt: 'tidy the docs',
    lastActivityAt: 1_700_000_000_000,
    pending: null,
    result: null,
    sessionRecord: null,
  });
});

test('it reads the creation time as the last activity of a session with no trail rows', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const record = await ctx.reads.readSessionRecord(session.id, null);

  expect(record).toMatchObject({ lastActivityAt: session.createdAt });
});

test('it reads the message a session waits on as pending', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  ctx.manager.updateAttention(session.id, 'needs_you', 'Allow the edit?');

  const record = await ctx.reads.readSessionRecord(session.id, null);

  expect(record).toMatchObject({ pending: { message: 'Allow the edit?' } });
});

test('it counts the trail rows of the agent session the session resumed', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  session.agentSessionID = toAgentSessionID('a-1');

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-earlier'), event: 'Stop', payload: { session_id: 'a-1' } },
    null,
    1_700_000_000_000,
  );

  const record = await ctx.reads.readSessionRecord(session.id, null);

  expect(record).toMatchObject({ lastActivityAt: 1_700_000_000_000 });
});

test('it counts only the own trail rows of the session under an access', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  session.agentSessionID = toAgentSessionID('a-1');

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-earlier'), event: 'Stop', payload: { session_id: 'a-1' } },
    null,
    1_700_000_000_000,
  );

  const access = buildTargetAccessFromGrants([
    { target: 'local', targetIdentity: 'local-pty:test' },
  ]);

  const record = await ctx.reads.readSessionRecord(session.id, access);

  expect(record).toMatchObject({ lastActivityAt: session.createdAt });
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

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const path = join(ctx.directory, 'transcript.jsonl');

  await Bun.write(path, 'first turn\nsecond turn\n');

  session.transcriptPath = path;

  const read = await ctx.reads.loadSessionTranscript(session.id, null, 10);

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

test('it pages the transcript of a finished session from inside its remote host', async () => {
  const ctx = await setupTest({
    adapter: {
      ...buildStubHarnessAdapter(),
      parseTranscriptLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    },
  });

  const session = await ctx.manager.spawn({
    cwd: '/root/work',
    name: 'worker',
    prompt: 'tidy the docs',
    cols: 80,
    rows: 24,
    target: 'guest',
  });

  const projects = `sessions/${session.id}/claude-config/projects/-root-work`;

  mkdirSync(join(ctx.guestFiles, projects), { recursive: true });

  await Bun.write(
    join(ctx.guestFiles, projects, 'a-1.jsonl'),
    'tidy the docs\nthe docs are tidy\n',
  );

  const path = `/tmp/atc/${projects}/a-1.jsonl`;

  session.transcriptPath = path;
  session.state = 'done';

  const read = await ctx.reads.loadSessionTranscript(session.id, null, 10);

  expect(read).toStrictEqual({
    path,
    page: {
      rows: [
        { role: 'user', text: 'tidy the docs', tools: [], at: null },
        { role: 'user', text: 'the docs are tidy', tools: [], at: null },
      ],
      offset: Buffer.byteLength('tidy the docs\nthe docs are tidy\n'),
      more: false,
    },
  });
});

test('it refuses a transcript read of a remote session whose target changed since it was bound', async () => {
  const ctx = await setupTest({
    adapter: {
      ...buildStubHarnessAdapter(),
      parseTranscriptLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    },
  });

  const session = await ctx.manager.spawn({
    cwd: '/root/work',
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
    target: 'guest',
  });

  session.transcriptPath = `/tmp/atc/sessions/${session.id}/a-1.jsonl`;
  session.targetIdentity = 'remote:replaced';

  const read = ctx.reads.loadSessionTranscript(session.id, null, 10);

  expect(read).rejects.toMatchObject({ code: 'target_changed' });
});

test('it reads an empty page for a session with no transcript yet', async () => {
  const ctx = await setupTest({
    adapter: {
      ...buildStubHarnessAdapter(),
      parseTranscriptLine: (line) => ({ role: 'user', text: line, tools: [], at: null }),
    },
  });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const read = await ctx.reads.loadSessionTranscript(session.id, null, 10);

  expect(read).toStrictEqual({ path: '', page: { rows: [], offset: 0, more: false } });
});

test('it refuses a transcript read for an agent that parses none', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });

  const session = await ctx.manager.spawn({
    cwd: ctx.directory,
    name: 'worker',
    prompt: '',
    cols: 80,
    rows: 24,
  });

  const read = await ctx.reads.loadSessionTranscript(session.id, null, 10);

  expect(read).toBe('unsupported');
});

test('it refuses a transcript read for a session the manager does not hold', async () => {
  const ctx = await setupTest({ adapter: buildStubHarnessAdapter() });
  const read = await ctx.reads.loadSessionTranscript(toSessionID('s-gone'), null, 10);

  expect(read).toBe('missing');
});
