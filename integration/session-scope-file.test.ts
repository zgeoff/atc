import { expect, test } from 'bun:test';
import { rmSync, statSync } from 'node:fs';
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
import invariant from 'tiny-invariant';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// A daemon in the test's process whose one target `box` runs each harness in
// its directory, under an agent that plans the scratch folder it is given.
async function setupTest() {
  const fixture = await createGitFixture({ prefix: 'atc-scope-file-' });

  const box = createStubDirProvider();

  const daemon = await startTestDaemon({
    prefix: 'atc-scope-file-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        planSpawn: () => ({ bin: 'sleep', args: ['30'], scratch: '/srv/scratch/cart-totals' }),
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

  return { fixture, box, daemon, records: join(daemon.directory, 'records') };
}

test('it lists the spawner as a reply channel and the scratch folder as an owned path in the scope file', async () => {
  const ctx = await setupTest();

  const lead = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
  });

  const leadID = String(getRecord(lead, 'session')['id']);

  const fromLead = await ctx.daemon.openClient({ session: leadID });

  const spawned = await fromLead.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);
  const harness = ctx.box.harnesses.find((candidate) => candidate.session === id);

  invariant(harness !== undefined, 'the spawn started no harness');

  const path = join(ctx.records, `${id}.scope.json`);

  const scopeFile = await readJSONRecord(Bun.file(path));

  expect(harness.env['AUTO_MODE_SCOPE_FILE']).toBe(path);
  expect(statSync(path).mode & 0o777).toBe(0o444);

  expect(scopeFile).toStrictEqual({
    format: 'auto-mode.scope',
    version: 1,
    paths: ['/srv/scratch/cart-totals'],
    workspace: { path: ctx.fixture.work, branch: 'main' },
    worktrees: [],
    branches: [],
    pullRequests: [],
    replyChannels: [{ tool: 'mcp__atc__atc_message_send', field: 'session', recipient: leadID }],
  });
});

test('it declares no reply channel for a session spawned from outside every session', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const scopeFile = await readJSONRecord(Bun.file(join(ctx.records, `${id}.scope.json`)));

  expect(scopeFile['replyChannels']).toStrictEqual([]);
});

test('it names the calling session as the spawner rather than the parent the spawn gives', async () => {
  const ctx = await setupTest();

  const lead = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
  });

  const other = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
  });

  const leadID = String(getRecord(lead, 'session')['id']);
  const otherID = String(getRecord(other, 'session')['id']);

  const fromLead = await ctx.daemon.openClient({ session: leadID });

  const spawned = await fromLead.sendRequest('session.spawn', {
    cwd: ctx.fixture.work,
    target: 'box',
    parent: otherID,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  const copy = await readJSONRecord(Bun.file(join(ctx.records, `${id}.json`)));

  expect(copy['spawner']).toBe(leadID);
});

test('it places the scope file with the stored spawner again when a restore revives the session', async () => {
  const fixture = await createGitFixture({ prefix: 'atc-scope-file-' });

  const box = createStubDirProvider();

  const daemon = await startTestDaemon({
    prefix: 'atc-scope-file-daemon-',
    options: async (paths) => {
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
        spawner: 's-lead',
        scratch: null,
        scope: {
          workspace: { path: fixture.work, branch: 'main', repoURL: null, sha: null },
          worktrees: [],
          branches: [],
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

  const path = join(daemon.directory, 'records', 's-kept.scope.json');

  rmSync(path, { force: true });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  await waitFor(() => {
    expect(box.harnesses).toHaveLength(1);
  });

  const scopeFile = await readJSONRecord(Bun.file(path));

  expect(scopeFile['replyChannels']).toStrictEqual([
    { tool: 'mcp__atc__atc_message_send', field: 'session', recipient: 's-lead' },
  ]);
});
