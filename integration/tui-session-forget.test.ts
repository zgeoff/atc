import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalPTYProvider } from '@atc/execution-local';
import { createStubExecutionProvider } from '@atc/execution-local/testing';
import type { DaemonClient } from '@atc/protocol/client';
import { buildMockAgentAdapter, createGitFixture, getRecord } from '@atc/test-utils';
import { createSessionActionsHarness } from '@atc/tui/testing';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// The overlay's session actions run against a daemon in the test's process, on a target the
// test gives; each session runs `sleep` in a real terminal, or in the stand-in provider's host.

function setupTest(client: DaemonClient) {
  const harness = createSessionActionsHarness(client);

  onTestFinished(harness.stop);

  return { ...harness, client };
}

test('#sendForget shows the kept folder and its reasons when the forget keeps the workspace', async () => {
  const git = await createGitFixture({ prefix: 'atc-tui-forget-' });

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
      ],
      workspaceCleanup: { enabled: true, check: 'unpushed' },
    }),
  });

  const ctx = setupTest(daemon.client);

  const spawned = await ctx.client.sendRequest('session.spawn', {
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
  const git = await createGitFixture({ prefix: 'atc-tui-forget-' });

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
      ],
      workspaceCleanup: { enabled: true, check: 'unpushed' },
    }),
  });

  const ctx = setupTest(daemon.client);

  const spawned = await ctx.client.sendRequest('session.spawn', {
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
  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: createLocalPTYProvider(),
        },
      ],
    }),
  });

  const ctx = setupTest(daemon.client);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.actions.sendForget(id);

  expect(ctx.overlay.notice).toBe(`session ${id} is live; stop it before forgetting it`);
});

test('#sendForget asks once more when the forget destroys the host, and destroys nothing yet', async () => {
  const provider = createStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const ctx = setupTest(daemon.client);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.actions.sendForget(id);

  expect({
    destroyID: ctx.service.getSnapshot().context.destroyID,
    destroyed: provider.destroyed,
  }).toStrictEqual({ destroyID: id, destroyed: [] });
});

test('#sendDestroy hands the offered token back and forgets the session with its host', async () => {
  const provider = createStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const ctx = setupTest(daemon.client);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
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
  const provider = createStubExecutionProvider({
    kind: 'imp-like',
    capabilities: { suspend: true, destroy: true },
  });

  provider.setDestroyFailure(new Error('the orchard host did not answer'));

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
      ],
    }),
  });

  const ctx = setupTest(daemon.client);

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: daemon.directory,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  await ctx.client.sendRequest('session.kill', { session: id });
  await ctx.actions.sendDestroy(id);

  expect(ctx.overlay.notice).toInclude('the orchard host did not answer');
});
