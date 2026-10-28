import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMockExecutionTarget } from '@atc/daemon/testing';
import { createStubDirProvider } from '@atc/execution-local/testing';
import { createStateStore } from '@atc/store';
import { buildMockFleetEntry } from '@atc/store/testing';
import {
  buildMockAgentAdapter,
  createGitFixture,
  getRecord,
  readJSONRecord,
  registerTestCleanup,
  waitFor,
} from '@atc/test-utils';
import { toAgentSessionID, toSessionID } from '@atcx/contract';
import { $ } from 'bun';
import invariant from 'tiny-invariant';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'atc-session-record-' });

  const box = createStubDirProvider();

  const daemon = await startTestDaemon({
    prefix: 'atc-session-record-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
      defaultTarget: 'box',
    }),
  });

  return { fixture, box, daemon, records: join(daemon.directory, 'records') };
}

test('it publishes a record of the workspace and each checked entry and gives the session its path', async () => {
  const ctx = await setupTest();

  const worktree = join(ctx.fixture.directory, 'fix-login');

  await $`git worktree add --quiet -b fix-login ${worktree}`
    .env(ctx.fixture.env)
    .cwd(ctx.fixture.work);

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
    scope: { worktrees: [{ path: worktree }], branches: [{ name: 'fix-login' }] },
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const [harness] = ctx.box.harnesses;

  invariant(harness !== undefined, 'the spawn started no harness');

  const path = join(ctx.records, `${id}.json`);

  expect(harness.env['ATC_SESSION_RECORD']).toBe(path);

  const copy = await readJSONRecord(Bun.file(path));

  expect(copy).toStrictEqual({
    format: 'atc.session-record',
    version: 1,
    session: id,
    daemonID: expect.any(String),
    target: 'box',
    revision: 1,
    updatedAt: expect.any(String),
    name: 'work',
    transcriptPath: null,
    spawner: null,
    scratch: null,
    scope: {
      workspace: { path: ctx.fixture.work, branch: 'main', repoURL: null, sha: null },
      worktrees: [{ path: worktree, branch: 'fix-login' }],
      branches: [{ name: 'fix-login', repo: ctx.fixture.work }],
      pullRequests: [],
    },
  });
});

test('it returns the published record from session.get', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const got = await ctx.daemon.client.sendRequest('session.get', { session: id });
  const copy = await readJSONRecord(Bun.file(join(ctx.records, `${id}.json`)));

  expect(got['sessionRecord']).toStrictEqual(copy);
});

test("it records the user's new name for the session and rewrites the copy", async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const path = join(ctx.records, `${id}.json`);

  await ctx.daemon.client.sendRequest('session.update', { session: id, name: 'cart rework' });

  const copy = await waitFor(async () => {
    const read = await readJSONRecord(Bun.file(path));

    expect(read['name']).toBe('cart rework');

    return read;
  });

  expect(copy['revision']).toBe(2);
});

test("it records the agent's name and transcript path for the session from its hook", async () => {
  const fixture = await createGitFixture({ prefix: 'atc-session-record-' });

  const box = createStubDirProvider();

  const daemon = await startTestDaemon({
    prefix: 'atc-session-record-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        planHookEvents: () => ({
          events: [
            {
              kind: 'started',
              transcriptSource: '/home/dev/.claude/projects/work/7b3e.jsonl',
              nameSource: '/home/dev/.claude/projects/work/7b3e.jsonl',
            },
          ],
        }),
        loadName: () => Promise.resolve({ name: 'invoice export', namedBy: 'agent' }),
      }),
      targets: [
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: fixture.work,
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const path = join(daemon.directory, 'records', `${id}.json`);

  await daemon.sendHookLines({ atcId: id, event: 'SessionStart', payload: {} });

  const copy = await waitFor(async () => {
    const read = await readJSONRecord(Bun.file(path));

    expect(read).toMatchObject({
      name: 'invoice export',
      transcriptPath: '/home/dev/.claude/projects/work/7b3e.jsonl',
    });

    return read;
  });

  const got = await daemon.client.sendRequest('session.get', { session: id });

  expect(got['sessionRecord']).toStrictEqual(copy);
});

test('it refuses a spawn whose scope holds a free-form key and starts nothing', async () => {
  const ctx = await setupTest();

  expect(
    ctx.daemon.client.sendRequest('session.spawn', {
      cwd: ctx.fixture.work,
      target: 'box',
      scope: { notes: 'anything under ~/src is fine' },
    }),
  ).rejects.toMatchObject({ code: 'scope_invalid', data: { entry: 'scope.notes' } });

  expect(ctx.box.harnesses).toBeEmpty();
});

test('it refuses a spawn whose worktree is not a git worktree and leaves no record', async () => {
  const ctx = await setupTest();

  const plain = join(ctx.fixture.directory, 'plain');

  mkdirSync(plain);

  expect(
    ctx.daemon.client.sendRequest('session.spawn', {
      cwd: ctx.fixture.work,
      target: 'box',
      scope: { worktrees: [{ path: plain }] },
    }),
  ).rejects.toMatchObject({
    code: 'scope_invalid',
    message: `scope.worktrees[0] ${plain} is not a git worktree on the session's host`,
    data: { entry: 'scope.worktrees[0]' },
  });

  expect(ctx.box.harnesses).toBeEmpty();

  // The daemon makes the copies' directory with its first copy.
  expect(existsSync(ctx.records)).toBeFalse();
});

// Root writes past file modes, so a read-only record holds only for a
// session that runs as another user.
test.skipIf(process.getuid?.() === 0)(
  "it refuses the session's own write to its record",
  async () => {
    const ctx = await setupTest();

    const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
      cwd: ctx.fixture.work,
      target: 'box',
    });

    const path = join(ctx.records, `${String(getRecord(spawned, 'session')['id'])}.json`);

    expect(statSync(path).mode & 0o777).toBe(0o444);

    expect(() => {
      writeFileSync(path, '{"scope":"everything"}');
    }).toThrow(expect.objectContaining({ code: 'EACCES' }));
  },
);

test('it adds scope from a client outside the session and rewrites the record', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await $`git branch later`.env(ctx.fixture.env).cwd(ctx.fixture.work);

  const added = await ctx.daemon.client.sendRequest('session.scope.add', {
    session: id,
    scope: { branches: [{ name: 'later' }] },
  });

  const record = getRecord(added, 'record');

  const copy = await readJSONRecord(Bun.file(join(ctx.records, `${id}.json`)));

  expect(record).toStrictEqual({
    format: 'atc.session-record',
    version: 1,
    session: id,
    daemonID: expect.any(String),
    target: 'box',
    revision: 2,
    updatedAt: expect.any(String),
    name: 'work',
    transcriptPath: null,
    spawner: null,
    scratch: null,
    scope: {
      workspace: { path: ctx.fixture.work, branch: 'main', repoURL: null, sha: null },
      worktrees: [],
      branches: [{ name: 'later', repo: ctx.fixture.work }],
      pullRequests: [],
    },
  });

  expect(copy).toStrictEqual(record);
});

test('it refuses an addition from a client inside the session itself', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const path = join(ctx.records, `${id}.json`);

  const before = await readJSONRecord(Bun.file(path));
  const own = await ctx.daemon.openClient({ session: id });

  expect(
    own.sendRequest('session.scope.add', { session: id, scope: { branches: [{ name: 'main' }] } }),
  ).rejects.toMatchObject({ code: 'unauthorized' });

  const copy = await readJSONRecord(Bun.file(path));

  expect(copy).toStrictEqual(before);
});

test("it refuses an addition from a sub-session to its parent's record", async () => {
  const ctx = await setupTest();

  const parent = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
  });

  const parentID = String(getRecord(parent, 'session')['id']);

  const child = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
    parent: parentID,
  });

  const fromChild = await ctx.daemon.openClient({
    session: String(getRecord(child, 'session')['id']),
  });

  expect(
    fromChild.sendRequest('session.scope.add', {
      session: parentID,
      scope: { branches: [{ name: 'main' }] },
    }),
  ).rejects.toMatchObject({ code: 'unauthorized' });
});

test("it adds to a sub-session's record from a client inside its parent", async () => {
  const ctx = await setupTest();

  const parent = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
  });

  const child = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
    parent: String(getRecord(parent, 'session')['id']),
  });

  const childID = String(getRecord(child, 'session')['id']);

  const fromParent = await ctx.daemon.openClient({
    session: String(getRecord(parent, 'session')['id']),
  });

  const added = await fromParent.sendRequest('session.scope.add', {
    session: childID,
    scope: { branches: [{ name: 'main' }] },
  });

  expect(getRecord(added, 'record')['scope']).toStrictEqual({
    workspace: { path: ctx.fixture.work, branch: 'main', repoURL: null, sha: null },
    worktrees: [],
    branches: [{ name: 'main', repo: ctx.fixture.work }],
    pullRequests: [],
  });
});

test('it refuses an addition whose entry fails its check and keeps the record', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const before = await readJSONRecord(Bun.file(join(ctx.records, `${id}.json`)));

  expect(
    ctx.daemon.client.sendRequest('session.scope.add', {
      session: id,
      scope: { pullRequests: [{ number: 'one' }] },
    }),
  ).rejects.toMatchObject({ code: 'scope_invalid', data: { entry: 'scope.pullRequests[0]' } });

  const copy = await readJSONRecord(Bun.file(join(ctx.records, `${id}.json`)));

  expect(copy).toStrictEqual(before);
});

test('it removes the record when the session is forgotten', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.daemon.client.sendRequest('session.forget', { session: id });

  expect(existsSync(join(ctx.records, `${id}.json`))).toBe(false);
});

test('it places the stored record again when a restore revives the session', async () => {
  const fixture = await createGitFixture({ prefix: 'atc-session-record-' });

  const box = createStubDirProvider();

  const daemon = await startTestDaemon({
    prefix: 'atc-session-record-daemon-',
    options: async (paths) => {
      // The fleet holds a session with a published record whose copy is
      // gone, as a cleared state directory leaves it.
      const store = await createStateStore(paths.dbPath);

      const stopStore = registerTestCleanup(() => store.stop());

      await store.writeFleet([
        buildMockFleetEntry({
          sessionID: toSessionID('s-kept'),
          name: 'kept session',
          cwd: fixture.work,
          agentSessionID: toAgentSessionID('agent-kept'),
          target: 'box',
          targetIdentity: 'test:box',
        }),
      ]);

      await store.writePublishedRecord({
        format: 'atc.session-record',
        version: 1,
        session: 's-kept',
        daemonID: store.daemonID,
        target: 'box',
        revision: 4,
        updatedAt: '2026-10-08T09:30:00.000Z',
        name: 'kept session',
        transcriptPath: null,
        spawner: null,
        scratch: null,
        scope: {
          workspace: { path: fixture.work, branch: 'main', repoURL: null, sha: null },
          worktrees: [],
          branches: [{ name: 'main', repo: fixture.work }],
          pullRequests: [],
        },
      });

      await stopStore();

      return {
        adapter: buildMockAgentAdapter(),
        targets: [
          buildMockExecutionTarget({
            id: 'box',
            kind: box.kind,
            identity: 'test:box',
            provider: box,
          }),
        ],
        defaultTarget: 'box',
      };
    },
  });

  const path = join(daemon.directory, 'records', 's-kept.json');

  rmSync(path, { force: true });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const harness = await waitFor(() => {
    const [revived] = box.harnesses;

    invariant(revived !== undefined, 'no harness revived yet');

    return revived;
  });

  expect(harness.env['ATC_SESSION_RECORD']).toBe(path);

  const copy = await readJSONRecord(Bun.file(path));

  expect(copy['revision']).toBe(4);
});
