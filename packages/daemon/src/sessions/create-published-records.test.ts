import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStateStore, parsePublishedRecord } from '@atc/store';
import {
  createGitFixture,
  getRecord,
  readJSONRecord,
  registerTestCleanup,
  setupTempDir,
} from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { $ } from 'bun';
import { z } from 'zod';
import { buildStubMemoryProvider } from '../testing/build-stub-memory-provider';
import { runLocalCommand } from '../testing/run-local-command';
import { PLACE_COPY_SCRIPT, createPublishedRecords } from './create-published-records';

async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'atc-records-' });

  const temporaryDirectory = setupTempDir('atc-records-state-');

  const store = await createStateStore(join(temporaryDirectory.path, 'atc.db'));

  registerTestCleanup(() => store.stop());

  const localDir = join(temporaryDirectory.path, 'records');

  const records = createPublishedRecords({
    store,
    daemonID: store.daemonID,
    localDir,
    ghBin: 'gh',
    now: () => Date.parse('2026-10-08T09:30:00.000Z'),
  });

  const provider = buildStubMemoryProvider({ kind: 'local-pty', runCommand: runLocalCommand });

  return { fixture, store, localDir, records, provider };
}

test('it publishes a read-only copy in the local directory and returns its path', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-local');

  const path = await ctx.records.createRecord(
    {
      session,
      target: 'local',
      name: 'login fix',
      transcriptPath: null,
      provider: ctx.provider,
      host: session,
      directory: ctx.fixture.work,
      workspace: null,
    },
    null,
    { spawner: null, scratch: null },
  );

  expect(path).toBe(join(ctx.localDir, 's-local.json'));
  expect(statSync(path).mode & 0o777).toBe(0o444);
  expect(statSync(ctx.localDir).mode & 0o777).toBe(0o700);

  const copy = await readJSONRecord(Bun.file(path));

  expect(copy).toStrictEqual({
    format: 'atc.session-record',
    version: 1,
    session: 's-local',
    daemonID: ctx.store.daemonID,
    target: 'local',
    revision: 1,
    updatedAt: '2026-10-08T09:30:00.000Z',
    name: 'login fix',
    transcriptPath: null,
    spawner: null,
    scratch: null,
    scope: {
      workspace: { path: ctx.fixture.work, branch: 'main', repoURL: null, sha: null },
      worktrees: [],
      branches: [],
      pullRequests: [],
    },
  });
});

test('it places a read-only scope file beside the local copy with the spawner and the scratch folder', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-scoped');

  await ctx.records.createRecord(
    {
      session,
      target: 'local',
      name: 'login fix',
      transcriptPath: null,
      provider: ctx.provider,
      host: session,
      directory: ctx.fixture.work,
      workspace: null,
    },
    null,
    { spawner: 's-lead', scratch: '/srv/scratch/s-scoped' },
  );

  const path = join(ctx.localDir, 's-scoped.scope.json');

  const scopeFile = await readJSONRecord(Bun.file(path));

  expect(statSync(path).mode & 0o777).toBe(0o444);

  expect(scopeFile).toStrictEqual({
    format: 'auto-mode.scope',
    version: 1,
    paths: ['/srv/scratch/s-scoped'],
    workspace: { path: ctx.fixture.work, branch: 'main' },
    worktrees: [],
    branches: [],
    pullRequests: [],
    replyChannels: [{ tool: 'mcp__atc__atc_message_send', field: 'session', recipient: 's-lead' }],
  });
});

test('it rewrites the scope file with an added branch and keeps the spawner', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-widened');

  const subject = {
    session,
    target: 'local',
    name: 'login fix',
    transcriptPath: null,
    provider: ctx.provider,
    host: session,
    directory: ctx.fixture.work,
    workspace: null,
  };

  await ctx.records.createRecord(subject, null, { spawner: 's-lead', scratch: null });
  await $`git branch later`.env(ctx.fixture.env).cwd(ctx.fixture.work);

  await ctx.records.updateScope(subject, {
    worktrees: [],
    branches: [{ name: 'later' }],
    pullRequests: [],
  });

  const scopeFile = await readJSONRecord(Bun.file(join(ctx.localDir, 's-widened.scope.json')));

  expect(scopeFile['branches']).toStrictEqual([{ name: 'later', repo: ctx.fixture.work }]);

  expect(scopeFile['replyChannels']).toStrictEqual([
    { tool: 'mcp__atc__atc_message_send', field: 'session', recipient: 's-lead' },
  ]);
});

test('it holds the record it publishes in the state store', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-held');

  const path = await ctx.records.createRecord(
    {
      session,
      target: 'local',
      name: 'login fix',
      transcriptPath: null,
      provider: ctx.provider,
      host: session,
      directory: ctx.fixture.work,
      workspace: null,
    },
    null,
    { spawner: null, scratch: null },
  );

  const stored = await ctx.store.readPublishedRecord(session);
  const text = await Bun.file(path).text();

  expect(stored).toStrictEqual(parsePublishedRecord(text));
});

test("it records a materialized workspace's repository and commit", async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-ws');

  const path = await ctx.records.createRecord(
    {
      session,
      target: 'local',
      name: 'login fix',
      transcriptPath: null,
      provider: ctx.provider,
      host: session,
      directory: ctx.fixture.work,
      workspace: {
        repoURL: 'https://github.com/me/app.git',
        sha: ctx.fixture.sha,
        ref: 'main',
        materializedAt: 1,
      },
    },
    null,
    { spawner: null, scratch: null },
  );

  const copy = await readJSONRecord(Bun.file(path));

  expect(getRecord(copy, 'scope')['workspace']).toStrictEqual({
    path: ctx.fixture.work,
    branch: 'main',
    repoURL: 'https://github.com/me/app.git',
    sha: ctx.fixture.sha,
  });
});

test('it records no branch for a directory outside git', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-plain');
  const plain = join(ctx.fixture.directory, 'plain');

  mkdirSync(plain);

  const path = await ctx.records.createRecord(
    {
      session,
      target: 'local',
      name: 'login fix',
      transcriptPath: null,
      provider: ctx.provider,
      host: session,
      directory: plain,
      workspace: null,
    },
    null,
    { spawner: null, scratch: null },
  );

  const copy = await readJSONRecord(Bun.file(path));

  expect(getRecord(copy, 'scope')['workspace']).toStrictEqual({
    path: plain,
    branch: null,
    repoURL: null,
    sha: null,
  });
});

test('it records the checked scope a spawn declares', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-scoped');
  const worktree = join(ctx.fixture.directory, 'fix');

  await $`git worktree add --quiet -b fix ${worktree}`.env(ctx.fixture.env).cwd(ctx.fixture.work);

  const path = await ctx.records.createRecord(
    {
      session,
      target: 'local',
      name: 'login fix',
      transcriptPath: null,
      provider: ctx.provider,
      host: session,
      directory: ctx.fixture.work,
      workspace: null,
    },
    { worktrees: [{ path: worktree }], branches: [{ name: 'fix' }], pullRequests: [] },
    { spawner: null, scratch: null },
  );

  const copy = await readJSONRecord(Bun.file(path));

  const scope = getRecord(copy, 'scope');

  expect(scope['worktrees']).toStrictEqual([{ path: worktree, branch: 'fix' }]);
  expect(scope['branches']).toStrictEqual([{ name: 'fix', repo: ctx.fixture.work }]);
});

test('it refuses a spawn whose declared scope fails its check and records nothing', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-refused');

  const created = ctx.records.createRecord(
    {
      session,
      target: 'local',
      name: 'login fix',
      transcriptPath: null,
      provider: ctx.provider,
      host: session,
      directory: ctx.fixture.work,
      workspace: null,
    },
    { worktrees: [], branches: [{ name: 'gone' }], pullRequests: [] },
    { spawner: null, scratch: null },
  );

  await Promise.allSettled([created]);

  const stored = await ctx.store.readPublishedRecord(session);

  expect(created).rejects.toMatchObject({
    code: 'scope_invalid',
    data: { entry: 'scope.branches[0]' },
  });

  expect(stored).toBeNull();
  expect(existsSync(join(ctx.localDir, 's-refused.json'))).toBe(false);
});

test('it places the stored copy again when a revive finds it gone', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-revived');

  const subject = {
    session,
    target: 'local',
    name: 'login fix',
    transcriptPath: null,
    provider: ctx.provider,
    host: session,
    directory: ctx.fixture.work,
    workspace: null,
  };

  const published = await ctx.records.createRecord(subject, null, { spawner: null, scratch: null });
  const before = await readJSONRecord(Bun.file(published));

  rmSync(published);

  const delivered = await ctx.records.restoreCopy(subject);

  expect(delivered).toBe(published);

  const copy = await readJSONRecord(Bun.file(delivered));

  expect(copy).toStrictEqual(before);
});

test('it records a fresh record when a revive finds a session without one', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-old');

  const delivered = await ctx.records.restoreCopy({
    session,
    target: 'local',
    name: 'login fix',
    transcriptPath: null,
    provider: ctx.provider,
    host: session,
    directory: ctx.fixture.work,
    workspace: null,
  });

  const copy = await readJSONRecord(Bun.file(delivered));

  expect(copy).toStrictEqual({
    format: 'atc.session-record',
    version: 1,
    session: 's-old',
    daemonID: ctx.store.daemonID,
    target: 'local',
    revision: 1,
    updatedAt: '2026-10-08T09:30:00.000Z',
    name: 'login fix',
    transcriptPath: null,
    spawner: null,
    scratch: null,
    scope: {
      workspace: { path: ctx.fixture.work, branch: 'main', repoURL: null, sha: null },
      worktrees: [],
      branches: [],
      pullRequests: [],
    },
  });
});

test('it records a new name and transcript path as the next revision and rewrites the copy', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-renamed');

  const path = await ctx.records.createRecord(
    {
      session,
      target: 'local',
      name: 'login fix',
      transcriptPath: null,
      provider: ctx.provider,
      host: session,
      directory: ctx.fixture.work,
      workspace: null,
    },
    null,
    { spawner: 's-lead', scratch: '/srv/scratch/s-renamed' },
  );

  await ctx.records.updateIdentity(
    {
      session,
      target: 'local',
      name: 'login fix, take two',
      transcriptPath: '/home/dev/.claude/projects/app/4d2c.jsonl',
      provider: ctx.provider,
      host: session,
      directory: ctx.fixture.work,
      workspace: null,
    },
    true,
  );

  const copy = await readJSONRecord(Bun.file(path));

  expect(copy).toStrictEqual({
    format: 'atc.session-record',
    version: 1,
    session: 's-renamed',
    daemonID: ctx.store.daemonID,
    target: 'local',
    revision: 2,
    updatedAt: '2026-10-08T09:30:00.000Z',
    name: 'login fix, take two',
    transcriptPath: '/home/dev/.claude/projects/app/4d2c.jsonl',
    spawner: 's-lead',
    scratch: '/srv/scratch/s-renamed',
    scope: {
      workspace: { path: ctx.fixture.work, branch: 'main', repoURL: null, sha: null },
      worktrees: [],
      branches: [],
      pullRequests: [],
    },
  });
});

test('it keeps the record and its revision when the name and transcript path are unchanged', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-unchanged');

  const subject = {
    session,
    target: 'local',
    name: 'login fix',
    transcriptPath: '/home/dev/.claude/projects/app/4d2c.jsonl',
    provider: ctx.provider,
    host: session,
    directory: ctx.fixture.work,
    workspace: null,
  };

  await ctx.records.createRecord(subject, null, { spawner: null, scratch: null });
  await ctx.records.updateIdentity(subject, true);

  const stored = await ctx.store.readPublishedRecord(session);

  expect(stored?.revision).toBe(1);
});

test('it stores a new name but leaves the copy when the copy is not to be placed', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-asleep');

  const path = await ctx.records.createRecord(
    {
      session,
      target: 'local',
      name: 'login fix',
      transcriptPath: null,
      provider: ctx.provider,
      host: session,
      directory: ctx.fixture.work,
      workspace: null,
    },
    null,
    { spawner: null, scratch: null },
  );

  const before = await Bun.file(path).text();

  await ctx.records.updateIdentity(
    {
      session,
      target: 'local',
      name: 'cart rework',
      transcriptPath: null,
      provider: ctx.provider,
      host: session,
      directory: ctx.fixture.work,
      workspace: null,
    },
    false,
  );

  const stored = await ctx.store.readPublishedRecord(session);
  const text = await Bun.file(path).text();

  expect(stored?.name).toBe('cart rework');
  expect(text).toBe(before);
});

test('it rewrites the copy on a rename retry after a failed copy write left the store ahead', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-rename-retried');

  const path = await ctx.records.createRecord(
    {
      session,
      target: 'local',
      name: 'login fix',
      transcriptPath: null,
      provider: ctx.provider,
      host: session,
      directory: ctx.fixture.work,
      workspace: null,
    },
    null,
    { spawner: null, scratch: null },
  );

  const renamed = {
    session,
    target: 'local',
    name: 'cart rework',
    transcriptPath: null,
    provider: ctx.provider,
    host: session,
    directory: ctx.fixture.work,
    workspace: null,
  };

  // A file where the copies' directory stands fails the next copy write.
  rmSync(ctx.localDir, { recursive: true, force: true });
  writeFileSync(ctx.localDir, '');

  const failed = ctx.records.updateIdentity(renamed, true);

  await Promise.allSettled([failed]);

  rmSync(ctx.localDir, { force: true });

  await ctx.records.updateIdentity(renamed, true);

  const copy = await readJSONRecord(Bun.file(path));

  expect(failed).rejects.toThrow();
  expect(copy).toMatchObject({ revision: 2, name: 'cart rework' });
});

test('it publishes a renamed record that a reader of the version 1 format before the name and transcript path parses', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-older-reader');

  const subject = {
    session,
    target: 'local',
    name: 'login fix',
    transcriptPath: '/home/dev/.claude/projects/app/4d2c.jsonl',
    provider: ctx.provider,
    host: session,
    directory: ctx.fixture.work,
    workspace: null,
  };

  const path = await ctx.records.createRecord(subject, null, { spawner: null, scratch: null });

  await ctx.records.updateIdentity({ ...subject, name: 'cart rework' }, true);

  // the reader's schema as the format stood before it gained the two fields
  const nullableString = z.string().nullable();
  const worktree = z.object({ path: z.string(), branch: nullableString });
  const branch = z.object({ name: z.string(), repo: z.string() });

  const pullRequest = z.object({
    repo: z.string(),
    number: z.number(),
    url: z.string(),
    branch: z.string(),
  });

  const workspace = z.object({
    path: z.string(),
    branch: nullableString,
    repoURL: nullableString,
    sha: nullableString,
  });

  const scope = z.object({
    workspace,
    worktrees: z.array(worktree),
    branches: z.array(branch),
    pullRequests: z.array(pullRequest),
  });

  const olderReader = z.object({
    format: z.literal('atc.session-record'),
    version: z.literal(1),
    session: z.string(),
    daemonID: z.string(),
    target: z.string(),
    revision: z.number().int().positive(),
    updatedAt: z.string(),
    scope,
  });

  const copy = await readJSONRecord(Bun.file(path));

  const parsed = olderReader.safeParse(copy);

  expect(copy).toMatchObject({
    version: 1,
    name: 'cart rework',
    transcriptPath: '/home/dev/.claude/projects/app/4d2c.jsonl',
  });

  expect(parsed.data).toStrictEqual({
    format: 'atc.session-record',
    version: 1,
    session: 's-older-reader',
    daemonID: ctx.store.daemonID,
    target: 'local',
    revision: 2,
    updatedAt: '2026-10-08T09:30:00.000Z',
    scope: {
      workspace: { path: ctx.fixture.work, branch: 'main', repoURL: null, sha: null },
      worktrees: [],
      branches: [],
      pullRequests: [],
    },
  });
});

test('it records nothing for a session without a record when its name changes', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-none');

  await ctx.records.updateIdentity(
    {
      session,
      target: 'local',
      name: 'cart rework',
      transcriptPath: null,
      provider: ctx.provider,
      host: session,
      directory: ctx.fixture.work,
      workspace: null,
    },
    true,
  );

  const stored = await ctx.store.readPublishedRecord(session);

  expect(stored).toBeNull();
  expect(existsSync(join(ctx.localDir, 's-none.json'))).toBe(false);
});

test('it records a name changed since the record was stored when a revive places the copy', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-revived-renamed');

  await ctx.records.createRecord(
    {
      session,
      target: 'local',
      name: 'login fix',
      transcriptPath: null,
      provider: ctx.provider,
      host: session,
      directory: ctx.fixture.work,
      workspace: null,
    },
    null,
    { spawner: null, scratch: null },
  );

  const delivered = await ctx.records.restoreCopy({
    session,
    target: 'local',
    name: 'cart rework',
    transcriptPath: '/home/dev/.claude/projects/app/9e1f.jsonl',
    provider: ctx.provider,
    host: session,
    directory: ctx.fixture.work,
    workspace: null,
  });

  const copy = await readJSONRecord(Bun.file(delivered));

  expect(copy).toMatchObject({
    revision: 2,
    name: 'cart rework',
    transcriptPath: '/home/dev/.claude/projects/app/9e1f.jsonl',
  });
});

test('it adds a checked scope, raises the revision, and rewrites the copy', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-added');

  const subject = {
    session,
    target: 'local',
    name: 'login fix',
    transcriptPath: null,
    provider: ctx.provider,
    host: session,
    directory: ctx.fixture.work,
    workspace: null,
  };

  const path = await ctx.records.createRecord(subject, null, { spawner: null, scratch: null });

  await $`git branch later`.env(ctx.fixture.env).cwd(ctx.fixture.work);

  const record = await ctx.records.updateScope(subject, {
    worktrees: [],
    branches: [{ name: 'later' }],
    pullRequests: [],
  });

  expect(record.revision).toBe(2);
  expect(record.scope.branches).toStrictEqual([{ name: 'later', repo: ctx.fixture.work }]);

  const text = await Bun.file(path).text();

  expect(parsePublishedRecord(text)).toStrictEqual(record);
  expect(statSync(path).mode & 0o777).toBe(0o444);
});

test('it keeps the record and its revision when an added scope holds nothing new', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-same');

  const subject = {
    session,
    target: 'local',
    name: 'login fix',
    transcriptPath: null,
    provider: ctx.provider,
    host: session,
    directory: ctx.fixture.work,
    workspace: null,
  };

  await ctx.records.createRecord(
    subject,
    { worktrees: [], branches: [{ name: 'main' }], pullRequests: [] },
    { spawner: null, scratch: null },
  );

  const record = await ctx.records.updateScope(subject, {
    worktrees: [],
    branches: [{ name: 'main' }],
    pullRequests: [],
  });

  expect(record.revision).toBe(1);
});

test('it leaves the record as it was when an added entry fails its check', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-kept');

  const subject = {
    session,
    target: 'local',
    name: 'login fix',
    transcriptPath: null,
    provider: ctx.provider,
    host: session,
    directory: ctx.fixture.work,
    workspace: null,
  };

  const path = await ctx.records.createRecord(subject, null, { spawner: null, scratch: null });
  const before = await ctx.store.readPublishedRecord(session);
  const beforeText = await Bun.file(path).text();

  const updated = ctx.records.updateScope(subject, {
    worktrees: [],
    branches: [{ name: 'main' }, { name: 'gone' }],
    pullRequests: [],
  });

  await Promise.allSettled([updated]);

  const text = await Bun.file(path).text();
  const stored = await ctx.store.readPublishedRecord(session);

  expect(updated).rejects.toMatchObject({
    code: 'scope_invalid',
    data: { entry: 'scope.branches[1]' },
  });

  expect(text).toBe(beforeText);
  expect(stored).toStrictEqual(before);
});

test('it applies two additions to one record one after the other', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-race');

  const subject = {
    session,
    target: 'local',
    name: 'login fix',
    transcriptPath: null,
    provider: ctx.provider,
    host: session,
    directory: ctx.fixture.work,
    workspace: null,
  };

  await ctx.records.createRecord(subject, null, { spawner: null, scratch: null });
  await $`git branch one && git branch two`.env(ctx.fixture.env).cwd(ctx.fixture.work);

  await Promise.all([
    ctx.records.updateScope(subject, {
      worktrees: [],
      branches: [{ name: 'one' }],
      pullRequests: [],
    }),
    ctx.records.updateScope(subject, {
      worktrees: [],
      branches: [{ name: 'two' }],
      pullRequests: [],
    }),
  ]);

  const stored = await ctx.store.readPublishedRecord(session);

  expect(stored?.revision).toBe(3);

  expect(stored?.scope.branches).toStrictEqual([
    { name: 'one', repo: ctx.fixture.work },
    { name: 'two', repo: ctx.fixture.work },
  ]);
});

test('it removes the record, its local copy, and its scope file', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-gone');

  const path = await ctx.records.createRecord(
    {
      session,
      target: 'local',
      name: 'login fix',
      transcriptPath: null,
      provider: ctx.provider,
      host: session,
      directory: ctx.fixture.work,
      workspace: null,
    },
    null,
    { spawner: null, scratch: null },
  );

  await ctx.records.remove(session);

  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(ctx.localDir, 's-gone.scope.json'))).toBe(false);

  const stored = await ctx.store.readPublishedRecord(session);

  expect(stored).toBeNull();
});

test('it rewrites the copy on a retry after a failed copy write left the store ahead', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-retried');

  const subject = {
    session,
    target: 'local',
    name: 'login fix',
    transcriptPath: null,
    provider: ctx.provider,
    host: session,
    directory: ctx.fixture.work,
    workspace: null,
  };

  const path = await ctx.records.createRecord(subject, null, { spawner: null, scratch: null });

  const added = { worktrees: [], branches: [{ name: 'main' }], pullRequests: [] };

  // A file where the copies' directory stands fails the next copy write.
  rmSync(ctx.localDir, { recursive: true, force: true });
  writeFileSync(ctx.localDir, '');

  const failed = ctx.records.updateScope(subject, added);

  await Promise.allSettled([failed]);

  rmSync(ctx.localDir, { force: true });

  const retried = await ctx.records.updateScope(subject, added);
  const text = await Bun.file(path).text();

  expect(failed).rejects.toThrow();
  expect(retried.revision).toBe(2);
  expect(parsePublishedRecord(text)).toStrictEqual(retried);
});

test("it never removes another session's copy", async () => {
  const ctx = await setupTest();

  const other = join(ctx.localDir, 's-other.json');

  mkdirSync(ctx.localDir, { recursive: true });
  writeFileSync(other, '{}');

  await ctx.records.remove(toSessionID('s-gone'));

  expect(existsSync(other)).toBe(true);
});

test("it places a remote copy in the records folder of the host's guest folder", async () => {
  const ctx = await setupTest();

  const provider = buildStubMemoryProvider({
    kind: 'box',
    remote: true,
    guest: { directory: '/var/lib/orchard-scratch/atc', atc: null },
  });

  const session = toSessionID('s-remote');

  await ctx.records.createRecord(
    {
      session,
      target: 'box',
      name: 'login fix',
      transcriptPath: null,
      provider,
      host: session,
      directory: '/work/app',
      workspace: null,
    },
    null,
    { spawner: null, scratch: null },
  );

  const placed = provider.commands.find((command) => command.argv[2] === PLACE_COPY_SCRIPT);

  expect(placed?.argv.slice(3, 6)).toStrictEqual([
    'sh',
    '/var/lib/orchard-scratch/atc/records',
    's-remote.json',
  ]);
});

test("it places a remote session's scope file beside its copy in the guest folder", async () => {
  const ctx = await setupTest();

  const provider = buildStubMemoryProvider({
    kind: 'box',
    remote: true,
    guest: { directory: '/var/lib/orchard-scratch/atc', atc: null },
  });

  const session = toSessionID('s-remote');

  await ctx.records.createRecord(
    {
      session,
      target: 'box',
      name: 'login fix',
      transcriptPath: null,
      provider,
      host: session,
      directory: '/work/app',
      workspace: null,
    },
    null,
    { spawner: 's-lead', scratch: '/var/lib/orchard-scratch/atc/sessions/s-remote/scratch' },
  );

  const placed = provider.commands.find((command) => command.argv[5] === 's-remote.scope.json');

  expect(placed?.argv.slice(2, 5)).toStrictEqual([
    PLACE_COPY_SCRIPT,
    'sh',
    '/var/lib/orchard-scratch/atc/records',
  ]);

  expect(JSON.parse(placed?.argv[7] ?? '')).toStrictEqual({
    format: 'auto-mode.scope',
    version: 1,
    paths: ['/var/lib/orchard-scratch/atc/sessions/s-remote/scratch'],
    workspace: { path: '/work/app', branch: null },
    worktrees: [],
    branches: [],
    pullRequests: [],
    replyChannels: [{ tool: 'mcp__atc__atc_message_send', field: 'session', recipient: 's-lead' }],
  });
});
