import { Database } from 'bun:sqlite';
import { expect, mock, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import invariant from 'tiny-invariant';
import { DaemonError } from '../protocol/daemon-error';
import { getRecord } from '../shared/get-record';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockExecutionTarget } from '../test-utils/build-mock-execution-target';
import { buildMockFleetEntry } from '../test-utils/build-mock-fleet-entry';
import { buildStubDirProvider } from '../test-utils/build-stub-dir-provider';
import { buildStubExecutionProvider } from '../test-utils/build-stub-execution-provider';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { createStubBin } from '../test-utils/create-stub-bin';
import { startGitHTTPServer } from '../test-utils/start-git-http-server';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { updateEnv } from '../test-utils/update-env';
import { waitFor } from '../test-utils/wait-for';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * A git fixture in `dir`, a bare upstream at `upstream` and a clone of it
 * at `work` holding one pushed commit `sha` that adds `README.md`. Fixture
 * git commands run with `env`, which reads neither the host's system nor
 * its global git config.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const git = await createGitFixture({ prefix: 'atc-workspace-' });

  stack.use(git);

  const owned = stack.move();

  return {
    dir: git.dir,
    env: git.env,
    upstream: git.upstream,
    work: git.work,
    sha: git.sha,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it materializes a path source at its pushed HEAD on the target and verifies it there', async () => {
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const dest = join(ctx.dir, 'box', 'ws');
  const before = Date.now();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  const head = await $`git rev-parse HEAD`.env(ctx.env).cwd(dest).text();

  const session = getRecord(spawned, 'session');

  expect(session).toMatchObject({ cwd: dest, locator: { targetID: 'box' } });

  expect(session['workspace']).toStrictEqual({
    repoURL: ctx.upstream,
    sha: ctx.sha,
    ref: 'main',
    materializedAt: expect.toBeWithin(before, Date.now() + 1),
  });

  expect(head.trim()).toBe(ctx.sha);
  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe(committed);
  expect(spawned).not.toContainKey('warnings');

  // The verify unsets every variable that could point git at another
  // repository before it reads the checkout's HEAD and status.
  expect(box.calls).toStrictEqual([
    { op: 'run', argv: ['sh', '-c', expect.any(String), 'sh', dest], cwd: '/' },
    { op: 'run', argv: ['mkdir', '-p', '--', join(ctx.dir, 'box')], cwd: '/' },
    { op: 'run', argv: ['mkdir', '--', dest], cwd: '/' },
    { op: 'transfer', dir: dest, bytes: expect.toBeNumber() },
    {
      op: 'run',
      argv: [
        'env',
        '-u',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        '-u',
        'GIT_COMMON_DIR',
        '-u',
        'GIT_CONFIG',
        '-u',
        'GIT_CONFIG_COUNT',
        '-u',
        'GIT_CONFIG_PARAMETERS',
        '-u',
        'GIT_DIR',
        '-u',
        'GIT_GRAFT_FILE',
        '-u',
        'GIT_IMPLICIT_WORK_TREE',
        '-u',
        'GIT_INDEX_FILE',
        '-u',
        'GIT_NO_REPLACE_OBJECTS',
        '-u',
        'GIT_OBJECT_DIRECTORY',
        '-u',
        'GIT_PREFIX',
        '-u',
        'GIT_REPLACE_REF_BASE',
        '-u',
        'GIT_SHALLOW_FILE',
        '-u',
        'GIT_WORK_TREE',
        'git',
        'rev-parse',
        '--verify',
        'HEAD^{commit}',
      ],
      cwd: dest,
    },
    {
      op: 'run',
      argv: [
        'env',
        '-u',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        '-u',
        'GIT_COMMON_DIR',
        '-u',
        'GIT_CONFIG',
        '-u',
        'GIT_CONFIG_COUNT',
        '-u',
        'GIT_CONFIG_PARAMETERS',
        '-u',
        'GIT_DIR',
        '-u',
        'GIT_GRAFT_FILE',
        '-u',
        'GIT_IMPLICIT_WORK_TREE',
        '-u',
        'GIT_INDEX_FILE',
        '-u',
        'GIT_NO_REPLACE_OBJECTS',
        '-u',
        'GIT_OBJECT_DIRECTORY',
        '-u',
        'GIT_PREFIX',
        '-u',
        'GIT_REPLACE_REF_BASE',
        '-u',
        'GIT_SHALLOW_FILE',
        '-u',
        'GIT_WORK_TREE',
        'git',
        '-c',
        'core.fsmonitor=false',
        'status',
        '--porcelain',
        '--untracked-files=no',
      ],
      cwd: dest,
    },
  ]);
});

test('it verifies the target checkout itself when the daemon env points git at another repository', async () => {
  await using ctx = await setupTest();

  // A git hook in a linked worktree exports GIT_DIR, and a daemon started
  // from one inherits it.
  const decoy = join(ctx.dir, 'decoy');

  await $`git init --quiet --template= --initial-branch=main ${decoy}`.env(ctx.env).quiet();

  await $`git -c user.name=atc -c user.email=atc@example.com commit --quiet --allow-empty -m decoy`
    .env(ctx.env)
    .cwd(decoy)
    .quiet();

  updateEnv('GIT_DIR', join(decoy, '.git'));

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(getRecord(spawned, 'session')['workspace']).toStrictEqual({
    repoURL: ctx.upstream,
    sha: ctx.sha,
    ref: 'main',
    materializedAt: expect.toBeNumber(),
  });
});

test('it fails the spawn when the target checkout lacks a tracked file, and removes it', async () => {
  await using ctx = await setupTest();

  // The unpack on the host leaves one tracked file out.
  const box = buildStubDirProvider({
    afterTransfer: async (dir) => {
      await rm(join(dir, 'README.md'));
    },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const dest = join(ctx.dir, 'box', 'ws');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toStrictEqual(
    new DaemonError(
      'workspace_mismatch',
      `the checkout on target 'box' does not match ${ctx.sha} in its tracked files:  D README.md`,
      { phase: 'verifying', expected: ctx.sha, actual: ctx.sha },
    ),
  );

  expect(listed).toStrictEqual({ sessions: [] });
  expect(existsSync(dest)).toBeFalse();
});

test('it removes only the directory it created when a symlink in the requested path changes before a rollback', async () => {
  await using ctx = await setupTest();

  const safe = join(ctx.dir, 'safe');
  const busy = join(ctx.dir, 'busy');
  const alias = join(ctx.dir, 'alias');

  mkdirSync(safe);
  mkdirSync(join(busy, 'ws', 'inner'), { recursive: true });
  writeFileSync(join(busy, 'ws', 'inner', 'keep.txt'), 'kept\n');
  symlinkSync(safe, alias);

  // The unpack leaves a tracked file out, and the requested path's symlink
  // moves to another directory before the rollback removes the checkout.
  const box = buildStubDirProvider({
    afterTransfer: async (dir) => {
      await rm(join(dir, 'README.md'));

      unlinkSync(alias);
      symlinkSync(busy, alias);
    },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(alias, 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'workspace_mismatch' });
  expect(readFileSync(join(busy, 'ws', 'inner', 'keep.txt'), 'utf8')).toBe('kept\n');
  expect(existsSync(join(safe, 'ws'))).toBeFalse();
});

test('it records a ready workspace and lists it again on the session after a restart', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const dest = join(ctx.dir, 'box', 'ws');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  const workspace = getRecord(spawned, 'session')['workspace'];

  await daemon.restart(() => ({
    adapter: buildMockAgentAdapter(),
    gitTransports: ['https', 'ssh', 'http', 'file'],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: 'test:local',
        provider: new LocalPTYProvider(),
      }),
      buildMockExecutionTarget({
        id: 'box',
        kind: 'fixture-dir',
        identity: 'test:box',
        provider: buildStubDirProvider(),
      }),
    ],
  }));

  const restored = await daemon.client.sendRequest('fleet.list');

  expect(restored).toStrictEqual({
    fleet: [expect.objectContaining({ cwd: dest, target: 'box', workspace })],
  });
});

test('it refuses a path source whose HEAD was never pushed, transferring nothing', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  writeFileSync(join(ctx.work, 'README.md'), 'unpushed\n');

  await $`git commit --quiet -am unpushed`.env(ctx.env).cwd(ctx.work).quiet();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  expect(spawn).rejects.toMatchObject({ code: 'unpushed_head', data: { phase: 'resolving' } });
  expect(box.calls).toStrictEqual([]);
  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses a path source with uncommitted changes as workspace_dirty when dirt is refused', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  writeFileSync(join(ctx.work, 'README.md'), 'edited\n');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work, allowDirty: 'refuse' },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'workspace_dirty' });
  expect(box.calls).toStrictEqual([]);
});

test('it materializes the committed HEAD of a dirty path source and leaves its changes behind', async () => {
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const dest = join(ctx.dir, 'box', 'ws');

  writeFileSync(join(ctx.work, 'README.md'), 'edited\n');
  writeFileSync(join(ctx.work, 'scratch.txt'), 'untracked\n');

  const before = await $`git status --porcelain`.env(ctx.env).cwd(ctx.work).text();

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  const session = getRecord(spawned, 'session');

  const after = await $`git status --porcelain`.env(ctx.env).cwd(ctx.work).text();
  const cloned = await $`git rev-parse HEAD`.env(ctx.env).cwd(dest).text();

  expect(session['workspace']).toStrictEqual({
    repoURL: ctx.upstream,
    sha: ctx.sha,
    ref: 'main',
    materializedAt: expect.toBeNumber(),
  });

  expect(cloned.trim()).toBe(ctx.sha);

  expect(spawned['warnings']).toStrictEqual([
    `cloned commit ${ctx.sha.slice(0, 12)}; left 2 uncommitted or untracked paths behind in ${ctx.work}`,
  ]);

  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe(committed);
  expect(existsSync(join(dest, 'scratch.txt'))).toBeFalse();
  expect(after).toBe(before);
  expect(readFileSync(join(ctx.work, 'README.md'), 'utf8')).toBe('edited\n');
  expect(readFileSync(join(ctx.work, 'scratch.txt'), 'utf8')).toBe('untracked\n');
});

test('it materializes the committed HEAD of a dirty path source when dirt is allowed with a warning', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const dest = join(ctx.dir, 'box', 'ws');

  writeFileSync(join(ctx.work, 'scratch.txt'), 'untracked\n');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'path', path: ctx.work, allowDirty: 'warn' },
  });

  expect(getRecord(spawned, 'session')['workspace']).toStrictEqual({
    repoURL: ctx.upstream,
    sha: ctx.sha,
    ref: 'main',
    materializedAt: expect.toBeNumber(),
  });

  expect(spawned['warnings']).toStrictEqual([
    `cloned commit ${ctx.sha.slice(0, 12)}; left 1 uncommitted or untracked path behind in ${ctx.work}`,
  ]);

  expect(existsSync(join(dest, 'scratch.txt'))).toBeFalse();
});

test('it refuses a dirty path source whose HEAD was never pushed, transferring nothing', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  writeFileSync(join(ctx.work, 'README.md'), 'unpushed\n');

  await $`git commit --quiet -am unpushed`.env(ctx.env).cwd(ctx.work).quiet();

  writeFileSync(join(ctx.work, 'scratch.txt'), 'untracked\n');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'unpushed_head', data: { phase: 'resolving' } });
  expect(box.calls).toStrictEqual([]);
});

test('it refuses a path source that uses submodules, transferring nothing', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  await $`git update-index --add --cacheinfo 160000,${ctx.sha},vendor/lib`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  await $`git commit --quiet -m submodule`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.env).cwd(ctx.work).quiet();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'has_submodules' });
  expect(box.calls).toStrictEqual([]);
});

test('it refuses a git source that tracks LFS paths, transferring nothing and leaving no directory', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const dest = join(ctx.dir, 'box', 'ws');

  writeFileSync(join(ctx.work, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  writeFileSync(join(ctx.work, 'model.bin'), 'version https://git-lfs.github.com/spec/v1\n');

  await $`git add .gitattributes model.bin`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git commit --quiet -m lfs`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.env).cwd(ctx.work).quiet();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'git', url: ctx.upstream, ref: 'main' },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'lfs_unsupported', data: { phase: 'cloning' } });
  expect(box.calls).not.toPartiallyContain({ op: 'transfer' });
  expect(existsSync(dest)).toBeFalse();
});

test('it refuses a path source whose git config rewrites its origin into a URL with a token', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  await $`git config ${`url.https://x-access-token:tok-1@example.com/.insteadOf`} ${ctx.upstream}`
    .env(ctx.env)
    .cwd(ctx.work)
    .quiet();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'credential_in_url' });
  expect(box.calls).toStrictEqual([]);
});

test('it refuses a git source whose URL carries a token', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'git', url: 'https://x-access-token:tok-1@example.com/r.git', ref: 'main' },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'credential_in_url' });
  expect(box.calls).toStrictEqual([]);
});

test('it keeps a workspace credential out of every row, the session, the fleet, and the log', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  updateEnv('ATC_TEST_WORKSPACE_TOKEN', 'tok-7d1e5a');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: {
      kind: 'git',
      url: ctx.upstream,
      ref: 'main',
      credentialRef: { kind: 'env', name: 'ATC_TEST_WORKSPACE_TOKEN' },
    },
  });

  const fleet = await daemon.client.sendRequest('fleet.list');

  const state = readdirSync(daemon.dir).filter((name) => name.startsWith('state.db'));
  const stored = state.map((name) => readFileSync(join(daemon.dir, name)).toString('latin1'));

  expect(state).not.toBeEmpty();
  expect(stored).toSatisfyAll((bytes: string) => !bytes.includes('tok-7d1e5a'));
  expect(JSON.stringify(spawned)).not.toInclude('tok-7d1e5a');
  expect(JSON.stringify(fleet)).not.toInclude('tok-7d1e5a');
  expect(daemon.logs).toStrictEqual([]);
});

test("it keeps a workspace credential out of a refusal that carries git's error, its log line, and every row", async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  updateEnv('ATC_TEST_WORKSPACE_TOKEN', 'tok-7d1e5a');

  // A ref spelled as the token makes git's own refusal carry it.
  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: {
      kind: 'git',
      url: ctx.upstream,
      ref: 'tok-7d1e5a',
      credentialRef: { kind: 'env', name: 'ATC_TEST_WORKSPACE_TOKEN' },
    },
  });

  await spawn.catch(() => null);

  const state = readdirSync(daemon.dir).filter((name) => name.startsWith('state.db'));
  const stored = state.map((name) => readFileSync(join(daemon.dir, name)).toString('latin1'));

  expect(spawn).rejects.toStrictEqual(
    new DaemonError('ref_not_found', "origin has no branch or tag '[credential]'", {
      phase: 'cloning',
    }),
  );

  expect(state).not.toBeEmpty();
  expect(stored).toSatisfyAll((bytes: string) => !bytes.includes('tok-7d1e5a'));
  expect(daemon.logs).not.toBeEmpty();
  expect(daemon.logs).toSatisfyAll((line: string) => !line.includes('tok-7d1e5a'));
});

test('it clones with the workspace credential and starts the harness without it or the askpass context', async () => {
  await using ctx = await setupTest();

  const server = startGitHTTPServer(ctx.dir, ctx.env);

  onTestFinished(async () => {
    await server.stop();
  });

  // The askpass variables stand in for a daemon whose own environment holds
  // them; the credential variable is the one the spawn names.
  updateEnv('ATC_TEST_WORKSPACE_CRED', 'fixture-not-a-secret');
  updateEnv('GIT_ASKPASS', '/fixture/askpass');
  updateEnv('ATC_GIT_ASKPASS_SECRET', 'fixture-not-a-secret');

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const dest = join(ctx.dir, 'box', 'ws');
  const url = `${server.url}upstream.git`;

  await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: {
      kind: 'git',
      url,
      ref: 'main',
      credentialRef: { kind: 'env', name: 'ATC_TEST_WORKSPACE_CRED' },
    },
  });

  const [harness] = box.harnesses;

  invariant(harness !== undefined, 'the spawn started no harness');

  const tree = await $`grep -rl fixture-not-a-secret ${dest}`.nothrow().quiet().text();
  const origin = await $`git config --get remote.origin.url`.env(ctx.env).cwd(dest).text();

  expect(server.authorizations).not.toBeEmpty();

  expect(server.authorizations).toSatisfyAll(
    (header: string) =>
      header === `Basic ${Buffer.from('x-access-token:fixture-not-a-secret').toString('base64')}`,
  );

  expect(harness.env).not.toContainAnyKeys([
    'ATC_TEST_WORKSPACE_CRED',
    'GIT_ASKPASS',
    'ATC_GIT_ASKPASS_SECRET',
  ]);

  expect(harness.env).toContainKey('ATC_SESSION_ID');
  expect(tree).toBe('');
  expect(origin.trim()).toBe(url);
});

test('it starts a revived harness after a restart without the workspace credential', async () => {
  await using ctx = await setupTest();

  const dest = join(ctx.dir, 'box', 'ws');

  updateEnv('ATC_TEST_WORKSPACE_CRED', 'fixture-not-a-secret');
  mkdirSync(dest, { recursive: true });

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: async (paths) => {
      // The fleet holds a ready git workspace on box, as a spawn under a
      // workspace credential leaves it.
      await using store = await StateStore.open(paths.dbPath);

      await store.createMaterialization(
        {
          sessionID: toSessionID('s-ws'),
          target: 'box',
          dir: dest,
          sourceKind: 'git',
          withheldEnv: ['ATC_TEST_WORKSPACE_CRED', 'GIT_ASKPASS', 'ATC_GIT_ASKPASS_SECRET'],
        },
        1000,
      );

      await store.updateMaterialization(
        toSessionID('s-ws'),
        { phase: 'ready', repoURL: ctx.upstream, sha: 'a'.repeat(40), materializedAt: 1000 },
        1000,
      );

      await store.writeFleet([
        buildMockFleetEntry({
          sessionID: toSessionID('s-ws'),
          cwd: dest,
          agentSessionID: toAgentSessionID('agent-ws'),
          target: 'box',
          targetIdentity: 'test:box',
        }),
      ]);

      return {
        adapter: buildMockAgentAdapter(),
        gitTransports: ['https', 'ssh', 'http', 'file'],
        targets: [
          buildMockExecutionTarget({
            id: 'local',
            kind: 'local-pty',
            identity: 'test:local',
            provider: new LocalPTYProvider(),
          }),
          buildMockExecutionTarget({
            id: 'box',
            kind: box.kind,
            identity: 'test:box',
            provider: box,
          }),
        ],
      };
    },
  });

  await daemon.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const harness = await waitFor(() => {
    const [revived] = box.harnesses;

    invariant(revived !== undefined, 'no harness revived yet');

    return revived;
  });

  expect(harness.cwd).toBe(dest);
  expect(harness.env).not.toContainKey('ATC_TEST_WORKSPACE_CRED');
});

test('it fails the spawn when the target checkout is not at the pinned commit, and removes it', async () => {
  await using ctx = await setupTest();

  const parent = await $`git rev-parse HEAD`.env(ctx.env).cwd(ctx.work).text();

  writeFileSync(join(ctx.work, 'README.md'), 'second\n');

  await $`git commit --quiet -am second`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.env).cwd(ctx.work).quiet();

  const pinned = await $`git rev-parse HEAD`.env(ctx.env).cwd(ctx.work).text();

  // The host's checkout lands on another commit than the one sent.
  const box = buildStubDirProvider({
    afterTransfer: async (dir) => {
      await Bun.write(join(dir, '.git', 'HEAD'), parent);
    },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const dest = join(ctx.dir, 'box', 'ws');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'git', url: ctx.upstream, sha: pinned.trim() },
  });

  await spawn.catch(() => null);

  const listed = await daemon.client.sendRequest('session.list');

  using db = new Database(daemon.dbPath, { readonly: true });

  const rows = db.query('SELECT phase, error_code, sha FROM workspace_materialization').all();

  expect(spawn).rejects.toMatchObject({
    code: 'workspace_mismatch',
    data: { phase: 'verifying', expected: pinned.trim(), actual: parent.trim() },
  });

  expect(listed).toStrictEqual({ sessions: [] });
  expect(existsSync(dest)).toBeFalse();

  expect(rows).toStrictEqual([
    { phase: 'failed', error_code: 'workspace_mismatch', sha: pinned.trim() },
  ]);
});

test.each([['transfer'], ['run']] as const)(
  'it refuses a workspace on a target whose provider cannot %s before any git command runs',
  async (capability) => {
    await using ctx = await setupTest();

    const box = buildStubDirProvider({ lacking: [capability] });

    await using daemon = await startTestDaemon({
      prefix: 'atc-workspace-daemon-',
      options: () => ({
        adapter: buildMockAgentAdapter(),
        gitTransports: ['https', 'ssh', 'http', 'file'],
        targets: [
          buildMockExecutionTarget({
            id: 'local',
            kind: 'local-pty',
            identity: 'test:local',
            provider: new LocalPTYProvider(),
          }),
          buildMockExecutionTarget({
            id: 'box',
            kind: box.kind,
            identity: 'test:box',
            provider: box,
          }),
        ],
      }),
    });

    // A dirty tree whose dirt is refused fails as workspace_dirty once
    // resolution runs.
    writeFileSync(join(ctx.work, 'README.md'), 'edited\n');

    const spawn = daemon.client.sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      target: 'box',
      workspace: { kind: 'path', path: ctx.work, allowDirty: 'refuse' },
    });

    await spawn.catch(() => null);

    using db = new Database(daemon.dbPath, { readonly: true });

    const rows = db.query('SELECT * FROM workspace_materialization').all();

    expect(spawn).rejects.toMatchObject({
      code: 'unsupported_operation',
      data: { provider: 'fixture-dir', capability },
    });

    expect(box.calls).toStrictEqual([]);
    expect(rows).toStrictEqual([]);
  },
);

test('it fails a materialization that a restart interrupts and lists no session for it', async () => {
  await using ctx = await setupTest();

  const held = Promise.withResolvers<undefined>();

  onTestFinished(() => {
    held.resolve(undefined);
  });

  const box = buildStubDirProvider({ afterTransfer: () => held.promise });

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  // The restart ends the spawn's connection, so its answer never comes.
  const spawn = Promise.allSettled([
    daemon.client.sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    }),
  ]);

  await waitFor(() => {
    expect(box.calls).toPartiallyContain({ op: 'transfer' });
  });

  await daemon.restart(() => ({
    adapter: buildMockAgentAdapter(),
    gitTransports: ['https', 'ssh', 'http', 'file'],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: 'test:local',
        provider: new LocalPTYProvider(),
      }),
      buildMockExecutionTarget({
        id: 'box',
        kind: 'fixture-dir',
        identity: 'test:box',
        provider: buildStubDirProvider(),
      }),
    ],
  }));

  await spawn;

  const listed = await daemon.client.sendRequest('session.list');

  using db = new Database(daemon.dbPath, { readonly: true });

  const rows = db.query('SELECT phase, error_code FROM workspace_materialization').all();

  expect(listed).toStrictEqual({ sessions: [] });
  expect(rows).toStrictEqual([{ phase: 'failed', error_code: 'workspace_interrupted' }]);
});

test("it logs the failure of an interrupted materialization that resumes into the stopped daemon's closed store", async () => {
  await using ctx = await setupTest();

  const held = Promise.withResolvers<undefined>();

  onTestFinished(() => {
    held.resolve(undefined);
  });

  const box = buildStubDirProvider({ afterTransfer: () => held.promise });

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  // The restart ends the spawn's connection, so its answer never comes.
  const spawn = Promise.allSettled([
    daemon.client.sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    }),
  ]);

  await waitFor(() => {
    expect(box.calls).toPartiallyContain({ op: 'transfer' });
  });

  await daemon.restart(() => ({
    adapter: buildMockAgentAdapter(),
    gitTransports: ['https', 'ssh', 'http', 'file'],
    targets: [
      buildMockExecutionTarget({
        id: 'local',
        kind: 'local-pty',
        identity: 'test:local',
        provider: new LocalPTYProvider(),
      }),
      buildMockExecutionTarget({
        id: 'box',
        kind: 'fixture-dir',
        identity: 'test:box',
        provider: buildStubDirProvider(),
      }),
    ],
  }));

  await spawn;

  held.resolve(undefined);

  await waitFor(() => {
    expect(daemon.logs).toSatisfyAny((line: string) => line.includes('failed while transferring'));
  });
});

test('it refuses to materialize into a directory that already exists and leaves it as it was', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const dest = join(ctx.dir, 'box', 'ws');

  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'mine.txt'), 'keep\n');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'workspace_exists', data: { dir: dest } });
  expect(box.calls).not.toPartiallyContain({ op: 'transfer' });
  expect(readdirSync(dest)).toStrictEqual(['mine.txt']);
});

test('it removes the checkout it created and keeps the files beside it when its harness fails to start', async () => {
  await using ctx = await setupTest();

  // A provider whose harness start throws, as a refused launch does.
  const box = buildStubExecutionProvider({
    kind: 'fixture-dir',
    onSpawn: () => {
      throw new DaemonError('host_unavailable', 'the harness could not start');
    },
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  mkdirSync(join(ctx.dir, 'box'));
  writeFileSync(join(ctx.dir, 'box', 'beside.txt'), 'kept\n');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'host_unavailable' });
  expect(readdirSync(join(ctx.dir, 'box'))).toStrictEqual(['beside.txt']);
  expect(readFileSync(join(ctx.dir, 'box', 'beside.txt'), 'utf8')).toBe('kept\n');
});

test('it spawns a retry into the directory a harness that failed to start left', async () => {
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  // A provider whose first harness start throws, as a refused launch does.
  const box = buildStubExecutionProvider({
    kind: 'fixture-dir',
    onSpawn: mock(() => {}).mockImplementationOnce(() => {
      throw new DaemonError('host_unavailable', 'the harness could not start');
    }),
  });

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  await daemon.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    })
    .catch(() => null);

  const retried = await daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  expect(getRecord(retried, 'session')['alive']).toBeTrue();
  expect(readFileSync(join(ctx.dir, 'box', 'ws', 'README.md'), 'utf8')).toBe(committed);
});

test.each([
  ['the same target', 'box'],
  ['another target on the same machine', 'local'],
] as const)(
  'it keeps a checkout that a session on %s runs inside when its spawn fails on a target without hosts',
  async (_where, insideTarget) => {
    await using ctx = await setupTest();

    const transferred = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();

    const box = buildStubDirProvider({
      afterTransfer: async (dir) => {
        unlinkSync(join(dir, 'README.md'));

        transferred.resolve();

        await released.promise;
      },
    });

    await using daemon = await startTestDaemon({
      prefix: 'atc-workspace-daemon-',
      options: () => ({
        adapter: buildMockAgentAdapter(),
        gitTransports: ['https', 'ssh', 'http', 'file'],
        targets: [
          buildMockExecutionTarget({
            id: 'local',
            kind: 'local-pty',
            identity: 'test:local',
            provider: new LocalPTYProvider(),
          }),
          buildMockExecutionTarget({
            id: 'box',
            kind: box.kind,
            identity: 'test:box',
            provider: box,
          }),
        ],
      }),
    });

    const dest = join(ctx.dir, 'box', 'ws');

    const spawn = daemon.client.sendRequest('session.spawn', {
      cwd: dest,
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    });

    await transferred.promise;

    mkdirSync(join(dest, 'inner'));
    writeFileSync(join(dest, 'inner', 'mine.txt'), 'kept\n');

    const inside = await daemon.client.sendRequest('session.spawn', {
      cwd: join(dest, 'inner'),
      target: insideTarget,
    });

    released.resolve();

    await spawn.catch(() => null);

    expect(spawn).rejects.toMatchObject({ code: 'workspace_mismatch', data: { leftDir: dest } });

    expect<Record<string, unknown>>({
      kept: readFileSync(join(dest, 'inner', 'mine.txt'), 'utf8'),
      alive: getRecord(inside, 'session')['alive'],
    }).toStrictEqual({ kept: 'kept\n', alive: true });
  },
);

test('it refuses a workspace spawn whose cwd is relative before anything runs', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: 'ws',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });
  expect(box.calls).toStrictEqual([]);
});

test('it refuses a directory outside git as the workspace of a target off the daemon host', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const plain = join(ctx.dir, 'plain');

  mkdirSync(plain);

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: plain },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'not_a_git_repo' });
  expect(box.calls).toStrictEqual([]);
});

test('it runs a local session in a directory outside git as it stands', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const plain = join(ctx.dir, 'plain');

  mkdirSync(plain);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: plain,
    target: 'local',
    workspace: { kind: 'path', path: plain },
  });

  using db = new Database(daemon.dbPath, { readonly: true });

  const rows = db.query('SELECT * FROM workspace_materialization').all();

  expect(getRecord(spawned, 'session')).not.toContainKey('workspace');
  expect(getRecord(spawned, 'session')['cwd']).toBe(plain);
  expect(rows).toStrictEqual([]);
});

test('it refuses to run a local repository in place when git cannot read its config', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  writeFileSync(join(ctx.work, '.git', 'config'), '[[[\n');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    target: 'local',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'unreadable_tree', data: { phase: 'resolving' } });
});

test('it refuses to run a local repository in place when git does not trust its owner', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  // git's own switch for treating every repository as another user's, with
  // the host's system and global config kept out, since a host that lists
  // the repository under safe.directory trusts it whatever its owner.
  updateEnv('GIT_TEST_ASSUME_DIFFERENT_OWNER', '1');
  updateEnv('GIT_CONFIG_NOSYSTEM', '1');
  updateEnv('GIT_CONFIG_GLOBAL', '/dev/null');

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    target: 'local',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'unreadable_tree', data: { phase: 'resolving' } });
});

test('it runs a local spawn without a workspace in a repository git cannot read', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  writeFileSync(join(ctx.work, '.git', 'config'), '[[[\n');

  const spawned = await daemon.client.sendRequest('session.spawn', { cwd: ctx.work });

  expect(getRecord(spawned, 'session')).toMatchObject({
    cwd: ctx.work,
    locator: { targetID: 'local' },
  });
});

test('it refuses a local directory outside git as the workspace of a spawn elsewhere', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const plain = join(ctx.dir, 'plain');

  mkdirSync(plain);

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'elsewhere'),
    target: 'local',
    workspace: { kind: 'path', path: plain },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'bad_args', data: { phase: 'resolving' } });
  expect(existsSync(join(ctx.dir, 'elsewhere'))).toBeFalse();
});

test('it materializes a git source on the local target like on any other', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const dest = join(ctx.dir, 'local', 'ws');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'local',
    workspace: { kind: 'git', url: ctx.upstream, ref: 'main' },
  });

  const head = await $`git rev-parse HEAD`.env(ctx.env).cwd(dest).text();

  expect(spawned).toMatchObject({
    session: { cwd: dest, workspace: { repoURL: ctx.upstream, sha: ctx.sha, ref: 'main' } },
  });

  expect(head.trim()).toBe(ctx.sha);
});

test('it materializes a git source without a cwd under the home on the local target and answers with its directory', async () => {
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const home = join(ctx.dir, 'home');

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      homeDir: home,
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const head = await $`git rev-parse HEAD`.env(ctx.env).cwd(ctx.work).text();

  const sha = head.trim();
  const dest = join(home, '.local/share/atc/workspaces', `upstream-main-${sha.slice(0, 7)}`);

  const spawned = await daemon.client.sendRequest('session.spawn', {
    target: 'local',
    workspace: { kind: 'git', url: ctx.upstream, ref: 'main', sha },
  });

  expect(spawned).toMatchObject({
    session: {
      cwd: dest,
      repoRoot: dest,
      name: `upstream-main-${sha.slice(0, 7)}`,
      workspace: { repoURL: ctx.upstream, sha, ref: 'main' },
    },
  });

  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe(committed);
});

test('it lands concurrent spawns of one repository without a cwd beside a directory that exists and leaves that directory as it was', async () => {
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const home = join(ctx.dir, 'home');
  const base = join(home, '.local/share/atc/workspaces', 'upstream-main');

  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'mine.txt'), 'keep\n');

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      homeDir: home,
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const workspace = { kind: 'git', url: ctx.upstream, ref: 'main' };

  const spawned = await Promise.all([
    daemon.client.sendRequest('session.spawn', { target: 'local', workspace }),
    daemon.client.sendRequest('session.spawn', { target: 'local', workspace }),
  ]);

  const sessions = spawned.map((answer) => getRecord(answer, 'session'));

  expect(sessions.map((session) => [session['cwd'], session['name']])).toIncludeSameMembers([
    [`${base}-2`, 'upstream-main-2'],
    [`${base}-3`, 'upstream-main-3'],
  ]);

  expect(readdirSync(base)).toStrictEqual(['mine.txt']);
  expect(readFileSync(join(`${base}-2`, 'README.md'), 'utf8')).toBe(committed);
  expect(readFileSync(join(`${base}-3`, 'README.md'), 'utf8')).toBe(committed);
});

test('it lands a git source without a cwd under the root the config sets for its target', async () => {
  await using ctx = await setupTest();

  // The README as the fixture committed it.
  const committed = await $`git show ${ctx.sha}:README.md`.env(ctx.env).cwd(ctx.work).text();

  const root = join(ctx.dir, 'roots', 'box');

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      workspaceRoots: {
        root: join(ctx.dir, 'roots', 'all'),
        targetRoots: new Map([['box', root]]),
      },
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    target: 'box',
    workspace: { kind: 'git', url: ctx.upstream, ref: 'main' },
  });

  expect(spawned).toMatchObject({ session: { cwd: join(root, 'upstream-main') } });
  expect(readFileSync(join(root, 'upstream-main', 'README.md'), 'utf8')).toBe(committed);
});

test('it refuses a git source without a cwd whose root it cannot write after one attempt, with the cause', async () => {
  await using ctx = await setupTest();

  const root = join(ctx.dir, 'read-only');
  const box = buildStubDirProvider();

  mkdirSync(root, { mode: 0o555 });

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      workspaceRoots: { root, targetRoots: new Map() },
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    target: 'box',
    workspace: { kind: 'git', url: ctx.upstream, ref: 'main' },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toBeInstanceOf(DaemonError);

  expect(spawn).rejects.toMatchObject({
    code: 'transfer_failed',
    message: expect.toInclude('Permission denied'),
  });

  expect(
    box.calls.filter(
      (call) => call.op === 'run' && call.argv[0] === 'mkdir' && call.argv[1] === '--',
    ),
  ).toStrictEqual([{ op: 'run', argv: ['mkdir', '--', join(root, 'upstream-main')], cwd: '/' }]);
});

test('it refuses a spawn without a cwd or a workspace as bad_args', async () => {
  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', { target: 'local' });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({
    code: 'bad_args',
    message: 'session.spawn requires a cwd',
  });
});

test('it refuses a spawn without a cwd whose workspace is not a git source before anything runs', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({
    code: 'bad_args',
    message: 'session.spawn requires a cwd',
  });

  expect(box.calls).toStrictEqual([]);
});

test('it runs a local spawn without a workspace in its directory as it stands', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', { cwd: ctx.work });

  using db = new Database(daemon.dbPath, { readonly: true });

  const rows = db.query('SELECT * FROM workspace_materialization').all();

  expect(getRecord(spawned, 'session')).not.toContainKey('workspace');

  expect(getRecord(spawned, 'session')).toMatchObject({
    cwd: ctx.work,
    locator: { targetID: 'local' },
  });

  expect(rows).toStrictEqual([]);
});

test('it checks out the sha of a git source that holds both on the branch its ref names', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const pinned = await $`git rev-parse HEAD`
    .env(ctx.env)
    .cwd(ctx.work)
    .text()
    .then((text) => text.trim());

  writeFileSync(join(ctx.work, 'later.txt'), 'later\n');

  await $`git add later.txt`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git commit --quiet -m later`.env(ctx.env).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.env).cwd(ctx.work).quiet();

  const dest = join(ctx.dir, 'box', 'ws');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'box',
    workspace: { kind: 'git', url: ctx.upstream, ref: 'main', sha: pinned },
  });

  const head = await $`git rev-parse HEAD`.env(ctx.env).cwd(dest).text();
  const branch = await $`git symbolic-ref HEAD`.env(ctx.env).cwd(dest).nothrow().text();

  expect(getRecord(spawned, 'session')['workspace']).toStrictEqual({
    repoURL: ctx.upstream,
    sha: pinned,
    ref: 'main',
    materializedAt: expect.toBeNumber(),
  });

  expect(head.trim()).toBe(pinned);
  expect(branch.trim()).toBe('refs/heads/main');
  expect(existsSync(join(dest, 'later.txt'))).toBeFalse();
});

test("it runs git from the daemon's PATH for a git spawn on an allowed transport", async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  // A git first on the PATH records each run.
  createStubBin(ctx.dir, 'git', `#!/bin/sh\necho "$@" >> '${join(ctx.dir, 'git-ran')}'\nexit 1\n`);
  updateEnv('PATH', `${ctx.dir}:${process.env['PATH'] ?? ''}`);

  await daemon.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws'),
      target: 'box',
      workspace: { kind: 'git', url: 'https://example.com/app.git', ref: 'main' },
    })
    .catch(() => null);

  expect(existsSync(join(ctx.dir, 'git-ran'))).toBeTrue();
});

test('it refuses a git source on a local transport before it runs git, transferring nothing', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  // A git first on the PATH records each run, so a refusal that runs git
  // leaves the record behind.
  createStubBin(ctx.dir, 'git', `#!/bin/sh\necho "$@" >> '${join(ctx.dir, 'git-ran')}'\nexit 1\n`);
  updateEnv('PATH', `${ctx.dir}:${process.env['PATH'] ?? ''}`);

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toStrictEqual(
    new DaemonError(
      'invalid_git_url',
      "git transport 'file' is not allowed; the daemon fetches over https and ssh",
      { phase: 'resolving' },
    ),
  );

  expect(box.calls).toStrictEqual([]);
  expect(existsSync(join(ctx.dir, 'git-ran'))).toBeFalse();
});

test('it refuses a path source whose origin is a local repository, in git, transferring nothing', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toStrictEqual(
    new DaemonError('clone_failed', "fatal: transport 'file' not allowed", { phase: 'cloning' }),
  );

  expect(box.calls).not.toPartiallyContain({ op: 'transfer' });
});

test('it holds a probe to the configured transports whatever transports it carries', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const probe = daemon.client.sendRequest('git.probe', {
    url: `file://${ctx.upstream}`,
    target: 'box',
    transports: ['file'],
    gitTransports: ['file'],
  });

  await probe.catch(() => null);

  expect(probe).rejects.toMatchObject({ code: 'invalid_git_url' });
  expect(box.calls).toStrictEqual([]);
});

test('it holds a spawn to the configured transports whatever transports it carries', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    gitTransports: ['file'],
    workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'invalid_git_url' });
  expect(box.calls).toStrictEqual([]);
});

test('it refuses a git source that carries transports of its own as bad_args', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: {
      kind: 'git',
      url: `file://${ctx.upstream}`,
      ref: 'main',
      gitTransports: ['file'],
    },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });
  expect(box.calls).toStrictEqual([]);
});

test('it holds git to the configured transports whatever the daemon environment allows', async () => {
  await using ctx = await setupTest();

  updateEnv('GIT_ALLOW_PROTOCOL', 'https:ssh:file');
  updateEnv('ATC_GIT_ALLOW_PROTOCOL', 'https:ssh:file');

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toStrictEqual(
    new DaemonError('clone_failed', "fatal: transport 'file' not allowed", { phase: 'cloning' }),
  );

  expect(box.calls).not.toPartiallyContain({ op: 'transfer' });
});

test('it materializes a spawn from the owner/repo shorthand at its GitHub https URL', async () => {
  await using ctx = await setupTest();

  // The rewrite sends the expanded URL to the fixture upstream, so no
  // request reaches GitHub.
  writeFileSync(
    join(ctx.dir, 'gitconfig'),
    `[url "file://${ctx.dir}/"]\n\tinsteadOf = https://github.com/acme/\n`,
  );

  updateEnv('GIT_CONFIG_GLOBAL', join(ctx.dir, 'gitconfig'));

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['https', 'ssh', 'http', 'file'],
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const dest = join(ctx.dir, 'local', 'ws');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: dest,
    target: 'local',
    workspace: { kind: 'git', url: 'acme/upstream', ref: 'main' },
  });

  expect(spawned).toMatchObject({
    session: { workspace: { repoURL: 'https://github.com/acme/upstream.git', ref: 'main' } },
  });
});

test("it runs git from the daemon's PATH for a probe under a valid transport list", async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  // A git first on the PATH records each run.
  createStubBin(ctx.dir, 'git', `#!/bin/sh\necho "$@" >> '${join(ctx.dir, 'git-ran')}'\nexit 1\n`);
  updateEnv('PATH', `${ctx.dir}:${process.env['PATH'] ?? ''}`);

  await daemon.client
    .sendRequest('git.probe', { url: 'https://example.com/app.git', target: 'box' })
    .catch(() => null);

  expect(existsSync(join(ctx.dir, 'git-ran'))).toBeTrue();
});

test('it refuses a probe under an invalid transport list before any git runs', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: {
        invalid:
          "workspaces.gitTransports holds 'ext', which atc never allows because it runs a command or reads a descriptor on the daemon host; the daemon runs no git until it is fixed",
      },
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  // A git first on the PATH records each run, so a refusal that runs git
  // leaves the record behind.
  createStubBin(ctx.dir, 'git', `#!/bin/sh\necho "$@" >> '${join(ctx.dir, 'git-ran')}'\nexit 1\n`);
  updateEnv('PATH', `${ctx.dir}:${process.env['PATH'] ?? ''}`);

  const refused = daemon.client.sendRequest('git.probe', {
    url: 'https://example.com/app.git',
    target: 'box',
  });

  await refused.catch(() => null);

  expect(refused).rejects.toMatchObject({
    code: 'git_transports_invalid',
    message:
      "workspaces.gitTransports in config.json is invalid, so the daemon runs no git: workspaces.gitTransports holds 'ext', which atc never allows because it runs a command or reads a descriptor on the daemon host; the daemon runs no git until it is fixed",
  });

  expect(existsSync(join(ctx.dir, 'git-ran'))).toBeFalse();
  expect(box.calls).toStrictEqual([]);
});

test('it refuses a git spawn under an invalid transport list before any git runs', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: {
        invalid:
          "workspaces.gitTransports holds 'ext', which atc never allows because it runs a command or reads a descriptor on the daemon host; the daemon runs no git until it is fixed",
      },
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  // A git first on the PATH records each run, so a refusal that runs git
  // leaves the record behind.
  createStubBin(ctx.dir, 'git', `#!/bin/sh\necho "$@" >> '${join(ctx.dir, 'git-ran')}'\nexit 1\n`);
  updateEnv('PATH', `${ctx.dir}:${process.env['PATH'] ?? ''}`);

  const refused = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws'),
    target: 'box',
    workspace: { kind: 'git', url: 'https://example.com/app.git', ref: 'main' },
  });

  await refused.catch(() => null);

  expect(refused).rejects.toMatchObject({
    code: 'git_transports_invalid',
    message:
      "workspaces.gitTransports in config.json is invalid, so the daemon runs no git: workspaces.gitTransports holds 'ext', which atc never allows because it runs a command or reads a descriptor on the daemon host; the daemon runs no git until it is fixed",
  });

  expect(existsSync(join(ctx.dir, 'git-ran'))).toBeFalse();
  expect(box.calls).toStrictEqual([]);
});

test("it runs git from the daemon's PATH for a checkout spawn under a valid transport list", async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  // A git first on the PATH records each run.
  createStubBin(ctx.dir, 'git', `#!/bin/sh\necho "$@" >> '${join(ctx.dir, 'git-ran')}'\nexit 1\n`);
  updateEnv('PATH', `${ctx.dir}:${process.env['PATH'] ?? ''}`);

  await daemon.client
    .sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'box', 'ws-path'),
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
    })
    .catch(() => null);

  expect(existsSync(join(ctx.dir, 'git-ran'))).toBeTrue();
});

test('it refuses a checkout spawn under an invalid transport list before any git runs', async () => {
  await using ctx = await setupTest();

  const box = buildStubDirProvider();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: {
        invalid:
          "workspaces.gitTransports holds 'ext', which atc never allows because it runs a command or reads a descriptor on the daemon host; the daemon runs no git until it is fixed",
      },
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: box.kind,
          identity: 'test:box',
          provider: box,
        }),
      ],
    }),
  });

  // A git first on the PATH records each run, so a refusal that runs git
  // leaves the record behind.
  createStubBin(ctx.dir, 'git', `#!/bin/sh\necho "$@" >> '${join(ctx.dir, 'git-ran')}'\nexit 1\n`);
  updateEnv('PATH', `${ctx.dir}:${process.env['PATH'] ?? ''}`);

  const refused = daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'box', 'ws-path'),
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await refused.catch(() => null);

  expect(refused).rejects.toMatchObject({
    code: 'git_transports_invalid',
    message:
      "workspaces.gitTransports in config.json is invalid, so the daemon runs no git: workspaces.gitTransports holds 'ext', which atc never allows because it runs a command or reads a descriptor on the daemon host; the daemon runs no git until it is fixed",
  });

  expect(existsSync(join(ctx.dir, 'git-ran'))).toBeFalse();
  expect(box.calls).toStrictEqual([]);
});

test('it spawns a local session under an invalid transport list', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: {
        invalid:
          "workspaces.gitTransports holds 'ext', which atc never allows because it runs a command or reads a descriptor on the daemon host; the daemon runs no git until it is fixed",
      },
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    target: 'local',
  });

  expect(spawned).toMatchObject({ session: { cwd: ctx.dir } });
});

test('it spawns a local session in a directory outside git under an invalid transport list', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    prefix: 'atc-workspace-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: {
        invalid:
          "workspaces.gitTransports holds 'ext', which atc never allows because it runs a command or reads a descriptor on the daemon host; the daemon runs no git until it is fixed",
      },
      targets: [
        buildMockExecutionTarget({
          id: 'local',
          kind: 'local-pty',
          identity: 'test:local',
          provider: new LocalPTYProvider(),
        }),
        buildMockExecutionTarget({
          id: 'box',
          kind: 'fixture-dir',
          identity: 'test:box',
          provider: buildStubDirProvider(),
        }),
      ],
    }),
  });

  mkdirSync(join(ctx.dir, 'loose'));

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'loose'),
    target: 'local',
    workspace: { kind: 'path', path: join(ctx.dir, 'loose') },
  });

  expect(spawned).toMatchObject({ session: { cwd: join(ctx.dir, 'loose') } });
});
