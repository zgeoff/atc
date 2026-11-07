import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalPTYProvider } from '@atc/execution-local';
import { createStubExecutionProvider } from '@atc/execution-local/testing';
import { buildMockAgentAdapter, createGitFixture, getRecord } from '@atc/test-utils';
import { createSessionActionsHarness } from '@atc/tui/testing';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// The overlay's session actions run against a daemon in the test's process. A session on
// `local` runs `sleep` in a real terminal; one on `imp` runs in a stand-in host that a forget
// destroys.

async function setupTest() {
  const imp = createStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: createLocalPTYProvider(),
        },
        { id: 'imp', kind: imp.kind, options: {}, identity: 'test:imp', provider: imp },
      ],
      workspaceCleanup: { enabled: true, check: 'unpushed' },
    }),
  });

  const harness = createSessionActionsHarness(daemon.client);

  onTestFinished(harness.stop);

  return { ...harness, imp, client: daemon.client, directory: daemon.directory };
}

test('#sendForget shows the kept folder and its reasons when the forget keeps the workspace', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-tui-forget-' });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    target: 'local',
    cwd: join(git.directory, 'orchard-main'),
    workspace: { kind: 'git', url: `file://${git.upstream}`, ref: 'main' },
    cols: 80,
    rows: 24,
  });

  const session = getRecord(spawned, 'session');

  writeFileSync(join(String(session['cwd']), 'harvest-plan.md'), '# pick the pears first\n');

  await ctx.client.sendRequest('session.kill', { session: session['id'] });
  await ctx.actions.sendForget(String(session['id']));

  expect(ctx.overlay.notice).toBe('kept orchard-main: 1 uncommitted or untracked path');
});

test('#sendForget shows no notice when the forget removes the workspace', async () => {
  const ctx = await setupTest();
  const git = await createGitFixture({ prefix: 'atc-tui-forget-' });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    target: 'local',
    cwd: join(git.directory, 'orchard-main'),
    workspace: { kind: 'git', url: `file://${git.upstream}`, ref: 'main' },
    cols: 80,
    rows: 24,
  });

  const id = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.actions.sendForget(String(id));

  expect(ctx.overlay.notice).toBeNull();
});

test("#sendForget shows the daemon's refusal of a forget of a session that came back to life", async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    target: 'local',
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.actions.sendForget(id);

  expect(ctx.overlay.notice).toBe(`session ${id} is live; stop it before forgetting it`);
});

test('#sendForget asks once more when the forget destroys the host, and destroys nothing yet', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    target: 'imp',
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.actions.sendForget(id);

  expect({
    destroyID: ctx.service.getSnapshot().context.destroyID,
    destroyed: ctx.imp.destroyed,
  }).toStrictEqual({ destroyID: id, destroyed: [] });
});

test('#sendDestroy hands the offered token back and forgets the session with its host', async () => {
  const ctx = await setupTest();

  const spawned = await ctx.client.sendRequest('session.spawn', {
    target: 'imp',
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.actions.sendDestroy(id);

  expect({
    notice: ctx.overlay.notice,
    listed: await ctx.client.sendRequest('session.list'),
  }).toStrictEqual({ notice: null, listed: { sessions: [] } });
});

test("#sendDestroy shows the daemon's refusal when the host destroy fails", async () => {
  const ctx = await setupTest();

  ctx.imp.setDestroyFailure(new Error('the orchard host did not answer'));

  const spawned = await ctx.client.sendRequest('session.spawn', {
    target: 'imp',
    cwd: ctx.directory,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.actions.sendDestroy(id);

  expect(ctx.overlay.notice).toInclude('the orchard host did not answer');
});
