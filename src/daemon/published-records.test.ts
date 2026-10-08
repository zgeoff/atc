import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { getRecord } from '../shared/get-record';
import { toSessionID } from '../shared/to-session-id';
import { parsePublishedRecord } from '../store/parse-published-record';
import { StateStore } from '../store/state-store';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { readJSONRecord } from '../test-utils/read-json-record';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { LocalPTYProvider } from './local-pty-provider';
import { PublishedRecords } from './published-records';

async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'atc-records-' });

  const tmp = setupTempDir('atc-records-state-');

  const store = await StateStore.open(join(tmp.dir, 'atc.db'));

  onTestFinished(() => store.stop());

  const localDir = join(tmp.dir, 'records');

  const records = new PublishedRecords({
    store,
    daemonID: store.daemonID,
    localDir,
    ghBin: 'gh',
    now: () => Date.parse('2026-10-08T09:30:00.000Z'),
  });

  return { fixture, store, localDir, records, provider: new LocalPTYProvider() };
}

test('it publishes a read-only copy in the local directory and returns its path', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-local');

  const path = await ctx.records.createRecord(
    {
      session,
      target: 'local',
      provider: ctx.provider,
      host: session,
      dir: ctx.fixture.work,
      workspace: null,
    },
    null,
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
    scope: {
      workspace: { path: ctx.fixture.work, branch: 'main', repoURL: null, sha: null },
      worktrees: [],
      branches: [],
      pullRequests: [],
    },
  });
});

test('it holds the record it publishes in the state store', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-held');

  const path = await ctx.records.createRecord(
    {
      session,
      target: 'local',
      provider: ctx.provider,
      host: session,
      dir: ctx.fixture.work,
      workspace: null,
    },
    null,
  );

  const stored = await ctx.store.findPublishedRecord(session);
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
      provider: ctx.provider,
      host: session,
      dir: ctx.fixture.work,
      workspace: {
        repoURL: 'https://github.com/me/app.git',
        sha: ctx.fixture.sha,
        ref: 'main',
        materializedAt: 1,
      },
    },
    null,
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
  const plain = join(ctx.fixture.dir, 'plain');

  mkdirSync(plain);

  const path = await ctx.records.createRecord(
    {
      session,
      target: 'local',
      provider: ctx.provider,
      host: session,
      dir: plain,
      workspace: null,
    },
    null,
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
  const worktree = join(ctx.fixture.dir, 'fix');

  await $`git worktree add --quiet -b fix ${worktree}`.env(ctx.fixture.env).cwd(ctx.fixture.work);

  const path = await ctx.records.createRecord(
    {
      session,
      target: 'local',
      provider: ctx.provider,
      host: session,
      dir: ctx.fixture.work,
      workspace: null,
    },
    { worktrees: [{ path: worktree }], branches: [{ name: 'fix' }], pullRequests: [] },
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
      provider: ctx.provider,
      host: session,
      dir: ctx.fixture.work,
      workspace: null,
    },
    { worktrees: [], branches: [{ name: 'gone' }], pullRequests: [] },
  );

  await Promise.allSettled([created]);

  const stored = await ctx.store.findPublishedRecord(session);

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
    provider: ctx.provider,
    host: session,
    dir: ctx.fixture.work,
    workspace: null,
  };

  const published = await ctx.records.createRecord(subject, null);
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
    provider: ctx.provider,
    host: session,
    dir: ctx.fixture.work,
    workspace: null,
  });

  const copy = await readJSONRecord(Bun.file(delivered));

  expect(copy['revision']).toBe(1);
});

test('it adds a checked scope, raises the revision, and rewrites the copy', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-added');

  const subject = {
    session,
    target: 'local',
    provider: ctx.provider,
    host: session,
    dir: ctx.fixture.work,
    workspace: null,
  };

  const path = await ctx.records.createRecord(subject, null);

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
    provider: ctx.provider,
    host: session,
    dir: ctx.fixture.work,
    workspace: null,
  };

  await ctx.records.createRecord(subject, {
    worktrees: [],
    branches: [{ name: 'main' }],
    pullRequests: [],
  });

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
    provider: ctx.provider,
    host: session,
    dir: ctx.fixture.work,
    workspace: null,
  };

  const path = await ctx.records.createRecord(subject, null);
  const before = await ctx.store.findPublishedRecord(session);
  const beforeText = await Bun.file(path).text();

  const updated = ctx.records.updateScope(subject, {
    worktrees: [],
    branches: [{ name: 'main' }, { name: 'gone' }],
    pullRequests: [],
  });

  await Promise.allSettled([updated]);

  const text = await Bun.file(path).text();
  const stored = await ctx.store.findPublishedRecord(session);

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
    provider: ctx.provider,
    host: session,
    dir: ctx.fixture.work,
    workspace: null,
  };

  await ctx.records.createRecord(subject, null);
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

  const stored = await ctx.store.findPublishedRecord(session);

  expect(stored?.revision).toBe(3);

  expect(stored?.scope.branches).toStrictEqual([
    { name: 'one', repo: ctx.fixture.work },
    { name: 'two', repo: ctx.fixture.work },
  ]);
});

test('it removes the record and its local copy', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-gone');

  const path = await ctx.records.createRecord(
    {
      session,
      target: 'local',
      provider: ctx.provider,
      host: session,
      dir: ctx.fixture.work,
      workspace: null,
    },
    null,
  );

  await ctx.records.remove(session);

  expect(existsSync(path)).toBe(false);

  const stored = await ctx.store.findPublishedRecord(session);

  expect(stored).toBeNull();
});

test('it rewrites the copy on a retry after a failed copy write left the store ahead', async () => {
  const ctx = await setupTest();

  const session = toSessionID('s-retried');

  const subject = {
    session,
    target: 'local',
    provider: ctx.provider,
    host: session,
    dir: ctx.fixture.work,
    workspace: null,
  };

  const path = await ctx.records.createRecord(subject, null);

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
