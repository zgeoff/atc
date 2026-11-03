import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalPTYProvider } from '@atc/execution-local';
import {
  buildMockAgentAdapter,
  createGitFixture,
  getRecord,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { $ } from 'bun';
import { startTestDaemon } from '../packages/app/src/test-utils/start-test-daemon';

// Each session runs `sleep` in a real terminal on the daemon's machine, in a workspace the daemon
// clones from the fixture's upstream; a git command a test runs there passes an identity, since
// the clone holds none under the test home.

test('it removes a workspace whose work is pushed, and the state folder, and reports removed', async () => {
  const git = await createGitFixture({ prefix: 'atc-forget-workspace-' });

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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(git.directory, 'shop-main'),
    workspace: { kind: 'git', url: `file://${git.upstream}`, ref: 'main' },
    cols: 80,
    rows: 24,
  });

  const session = getRecord(spawned, 'session');
  const cwd = String(session['cwd']);
  const stateFolder = join(daemon.directory, 'sessions', String(session['id']), 'scratch');

  mkdirSync(stateFolder, { recursive: true });

  await daemon.client.sendRequest('session.kill', { session: session['id'] });

  const forgotten = await daemon.client.sendRequest('session.forget', { session: session['id'] });

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'removed', path: cwd, found: [] },
  });

  expect(existsSync(cwd)).toBeFalse();
  expect(existsSync(stateFolder)).toBeFalse();
});

test('it keeps a workspace with an uncommitted change, removes the state folder, and reports why', async () => {
  const git = await createGitFixture({ prefix: 'atc-forget-workspace-' });

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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(git.directory, 'shop-main'),
    workspace: { kind: 'git', url: `file://${git.upstream}`, ref: 'main' },
    cols: 80,
    rows: 24,
  });

  const session = getRecord(spawned, 'session');
  const cwd = String(session['cwd']);
  const stateFolder = join(daemon.directory, 'sessions', String(session['id']));

  mkdirSync(stateFolder, { recursive: true });
  writeFileSync(join(cwd, 'plan.md'), '# next steps\n');

  await daemon.client.sendRequest('session.kill', { session: session['id'] });

  const forgotten = await daemon.client.sendRequest('session.forget', { session: session['id'] });

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'kept', path: cwd, reasons: ['1 uncommitted or untracked path'] },
  });

  expect(existsSync(join(cwd, 'plan.md'))).toBeTrue();
  expect(existsSync(stateFolder)).toBeFalse();
});

test('it waits for a killed session that exits late, and keeps what it wrote on the way out', async () => {
  const git = await createGitFixture({ prefix: 'atc-forget-workspace-' });

  const trapped = join(git.directory, 'trap-ready');

  const daemon = await startTestDaemon({
    options: () => ({
      adapter: buildMockAgentAdapter({
        planSpawn: () => ({
          bin: 'sh',
          args: [
            '-c',
            `trap 'sleep 0.5; echo "- ship the cart fix" > late-notes.md; exit 0' HUP TERM; : > '${trapped}'; while :; do sleep 0.1; done`,
          ],
        }),
      }),
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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(git.directory, 'shop-main'),
    workspace: { kind: 'git', url: `file://${git.upstream}`, ref: 'main' },
    cols: 80,
    rows: 24,
  });

  const session = getRecord(spawned, 'session');
  const cwd = String(session['cwd']);

  await waitFor(() => {
    expect(existsSync(trapped)).toBeTrue();
  });

  await daemon.client.sendRequest('session.kill', { session: session['id'] });

  const forgotten = await daemon.client.sendRequest('session.forget', { session: session['id'] });

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'kept', path: cwd, reasons: ['1 uncommitted or untracked path'] },
  });

  expect(existsSync(join(cwd, 'late-notes.md'))).toBeTrue();
});

test('it keeps a workspace with a stash and reports it', async () => {
  const git = await createGitFixture({ prefix: 'atc-forget-workspace-' });

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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(git.directory, 'shop-main'),
    workspace: { kind: 'git', url: `file://${git.upstream}`, ref: 'main' },
    cols: 80,
    rows: 24,
  });

  const session = getRecord(spawned, 'session');
  const cwd = String(session['cwd']);

  writeFileSync(join(cwd, 'README.md'), 'hello, set aside\n');

  await $`git -c user.name=tester -c user.email=tester@example.com stash --quiet`
    .env(git.env)
    .cwd(cwd)
    .quiet();

  await daemon.client.sendRequest('session.kill', { session: session['id'] });

  const forgotten = await daemon.client.sendRequest('session.forget', { session: session['id'] });

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'kept', path: cwd, reasons: ['1 stash'] },
  });

  expect(existsSync(cwd)).toBeTrue();
});

test('it keeps a workspace with unpushed commits on a branch and reports them', async () => {
  const git = await createGitFixture({ prefix: 'atc-forget-workspace-' });

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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(git.directory, 'shop-main'),
    workspace: { kind: 'git', url: `file://${git.upstream}`, ref: 'main' },
    cols: 80,
    rows: 24,
  });

  const session = getRecord(spawned, 'session');
  const cwd = String(session['cwd']);

  await $`git switch --quiet -c fix-cart`.env(git.env).cwd(cwd).quiet();

  await $`git -c user.name=tester -c user.email=tester@example.com commit --quiet --allow-empty -m ${'fix the cart total'}`
    .env(git.env)
    .cwd(cwd)
    .quiet();

  await $`git -c user.name=tester -c user.email=tester@example.com commit --quiet --allow-empty -m ${'cover the cart total'}`
    .env(git.env)
    .cwd(cwd)
    .quiet();

  await daemon.client.sendRequest('session.kill', { session: session['id'] });

  const forgotten = await daemon.client.sendRequest('session.forget', { session: session['id'] });

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'kept', path: cwd, reasons: ['2 unpushed commits on fix-cart'] },
  });

  expect(existsSync(cwd)).toBeTrue();
});

test('it keeps a workspace with a commit made on a detached HEAD and reports it', async () => {
  const git = await createGitFixture({ prefix: 'atc-forget-workspace-' });

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

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(git.directory, 'shop-main'),
    workspace: { kind: 'git', url: `file://${git.upstream}`, ref: 'main' },
    cols: 80,
    rows: 24,
  });

  const session = getRecord(spawned, 'session');
  const cwd = String(session['cwd']);

  await $`git switch --quiet --detach`.env(git.env).cwd(cwd).quiet();

  await $`git -c user.name=tester -c user.email=tester@example.com commit --quiet --allow-empty -m ${'try a lighter query'}`
    .env(git.env)
    .cwd(cwd)
    .quiet();

  await daemon.client.sendRequest('session.kill', { session: session['id'] });

  const forgotten = await daemon.client.sendRequest('session.forget', { session: session['id'] });

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'kept', path: cwd, reasons: ['1 unpushed commit on a detached HEAD'] },
  });

  expect(existsSync(cwd)).toBeTrue();
});

test('it keeps the workspace and the state folder when cleanup is off', async () => {
  const git = await createGitFixture({ prefix: 'atc-forget-workspace-' });

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
      workspaceCleanup: { enabled: false, check: 'unpushed' },
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(git.directory, 'shop-main'),
    workspace: { kind: 'git', url: `file://${git.upstream}`, ref: 'main' },
    cols: 80,
    rows: 24,
  });

  const session = getRecord(spawned, 'session');
  const stateFolder = join(daemon.directory, 'sessions', String(session['id']));

  mkdirSync(stateFolder, { recursive: true });

  await daemon.client.sendRequest('session.kill', { session: session['id'] });

  const forgotten = await daemon.client.sendRequest('session.forget', { session: session['id'] });

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'none' },
  });

  expect(existsSync(String(session['cwd']))).toBeTrue();
  expect(existsSync(stateFolder)).toBeTrue();
});

test('it removes a workspace with an unpushed commit under the none check, and lists the commit', async () => {
  const git = await createGitFixture({ prefix: 'atc-forget-workspace-' });

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
      workspaceCleanup: { enabled: true, check: 'none' },
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(git.directory, 'shop-main'),
    workspace: { kind: 'git', url: `file://${git.upstream}`, ref: 'main' },
    cols: 80,
    rows: 24,
  });

  const session = getRecord(spawned, 'session');
  const cwd = String(session['cwd']);

  await $`git -c user.name=tester -c user.email=tester@example.com commit --quiet --allow-empty -m ${'draft the cart total'}`
    .env(git.env)
    .cwd(cwd)
    .quiet();

  await daemon.client.sendRequest('session.kill', { session: session['id'] });

  const forgotten = await daemon.client.sendRequest('session.forget', { session: session['id'] });

  expect(forgotten).toStrictEqual({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'removed', path: cwd, found: ['1 unpushed commit on main'] },
  });

  expect(existsSync(cwd)).toBeFalse();
});

test.each([['unpushed' as const], ['none' as const]])(
  'it keeps a folder atc did not create under the %s check',
  async (check) => {
    const temporaryDirectory = setupTempDir('atc-forget-plain-');

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
        workspaceCleanup: { enabled: true, check },
      }),
    });

    const folder = join(temporaryDirectory.path, 'hand-made');

    mkdirSync(folder);
    writeFileSync(join(folder, 'notes.md'), '# mine\n');

    const spawned = await daemon.client.sendRequest('session.spawn', {
      cwd: folder,
      cols: 80,
      rows: 24,
    });

    const id = getRecord(spawned, 'session')['id'];

    await daemon.client.sendRequest('session.kill', { session: id });

    const forgotten = await daemon.client.sendRequest('session.forget', { session: id });

    expect(forgotten).toStrictEqual({
      forgotten: true,
      destroyed: false,
      workspace: { outcome: 'none' },
    });

    expect(existsSync(join(folder, 'notes.md'))).toBeTrue();
  },
);

test.each([['unpushed' as const], ['none' as const]])(
  'it keeps a workspace another listed session runs in under the %s check',
  async (check) => {
    const git = await createGitFixture({ prefix: 'atc-forget-workspace-' });

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
        workspaceCleanup: { enabled: true, check },
      }),
    });

    const spawned = await daemon.client.sendRequest('session.spawn', {
      cwd: join(git.directory, 'shop-main'),
      workspace: { kind: 'git', url: `file://${git.upstream}`, ref: 'main' },
      cols: 80,
      rows: 24,
    });

    const session = getRecord(spawned, 'session');
    const cwd = String(session['cwd']);

    const neighbour = await daemon.client.sendRequest('session.spawn', { cwd, cols: 80, rows: 24 });

    const neighbourID = String(getRecord(neighbour, 'session')['id']);

    await daemon.client.sendRequest('session.kill', { session: session['id'] });

    const forgotten = await daemon.client.sendRequest('session.forget', {
      session: session['id'],
    });

    expect(forgotten).toStrictEqual({
      forgotten: true,
      destroyed: false,
      workspace: { outcome: 'kept', path: cwd, reasons: [`in use by session ${neighbourID}`] },
    });

    expect(existsSync(cwd)).toBeTrue();
  },
);
