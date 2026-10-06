import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { setupTempDir } from '../../test/setup-temp-dir';
import { updateEnv } from '../../test/update-env';
import { waitFor } from '../../test/wait-for';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { DaemonClient } from '../client/daemon-client';
import { parseConfig } from '../shared/config';
import { startDaemon } from './daemon';
import { LocalPTYProvider } from './local-pty-provider';

async function setupTest(
  options: { readonly targetTrust?: boolean; readonly failHarnessAfterTrust?: boolean } = {},
) {
  const tmp = setupTempDir('atc-local-workspace-trust-');
  const marker = join(tmp.dir, 'started');
  const fakeClaude = join(tmp.dir, 'fake-claude');
  const upstream = join(tmp.dir, 'upstream.git');
  const work = join(tmp.dir, 'work');
  const claudeConfigDir = join(tmp.dir, 'claude-home');

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();
  await $`git config user.name atc`.env(env).cwd(work).quiet();
  await $`git config user.email atc@example.com`.env(env).cwd(work).quiet();
  await $`git config commit.gpgsign false`.env(env).cwd(work).quiet();

  writeFileSync(join(work, 'README.md'), 'hello\n');

  await $`git add README.md`.env(env).cwd(work).quiet();
  await $`git commit --quiet -m initial`.env(env).cwd(work).quiet();
  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${marker}"\nexec sleep 30\n`, {
    mode: 0o755,
  });

  mkdirSync(claudeConfigDir);
  updateEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);

  const config = parseConfig({ claudeBin: fakeClaude });

  const adapter = new ClaudeAdapter(config);

  // Once the real trust write lands, the CLI stops being executable, so
  // the harness start that follows it fails.
  if (options.failHarnessAfterTrust === true) {
    adapter.updateLocalWorkspaceTrust = async (root) => {
      const remove = await ClaudeAdapter.prototype.updateLocalWorkspaceTrust.call(adapter, root);

      chmodSync(fakeClaude, 0o644);

      return remove;
    };
  }

  const socketPath = join(tmp.dir, 'daemon.sock');

  const daemon = await startDaemon({
    socketPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter,
    adapters: [adapter],
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    gitTransports: ['file'],
    targets: [
      {
        id: 'local',
        kind: 'local-pty',
        options:
          options.targetTrust === undefined ? {} : { trustClonedWorkspace: options.targetTrust },
        identity: 'local:test',
        provider: new LocalPTYProvider(),
      },
    ],
    defaultTarget: 'local',
  });

  const client = await DaemonClient.open(socketPath);

  await client.sendHello('atc/test-build');

  return {
    client,
    marker,
    upstream,
    claudeConfig: join(claudeConfigDir, '.claude.json'),
    dir: tmp.dir,
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}

test('it trusts only the resolved clone root in the user config after an opted-in local launch', async () => {
  await using daemon = await setupTest();

  const parent = join(daemon.dir, 'physical');
  const alias = join(daemon.dir, 'alias');

  mkdirSync(parent);
  symlinkSync(parent, alias);
  mkdirSync(join(parent, 'sibling'));

  const root = join(parent, 'clone');

  writeFileSync(
    daemon.claudeConfig,
    JSON.stringify(
      {
        numStartups: 4,
        projects: {
          '/home/me/projects': { hasTrustDialogAccepted: true, allowedTools: [] },
          '/home/me/scratch': { hasTrustDialogAccepted: false },
        },
      },
      null,
      2,
    ),
  );

  await daemon.client.sendRequest('session.spawn', {
    trustClonedWorkspace: true,
    cwd: join(alias, 'clone'),
    agent: 'claude',
    target: 'local',
    prompt: 'start the task',
    workspace: { kind: 'git', url: `file://${daemon.upstream}`, ref: 'main' },
  });

  await waitFor(() => {
    expect(existsSync(daemon.marker)).toBeTrue();

    return true;
  });

  const config: unknown = JSON.parse(readFileSync(daemon.claudeConfig, 'utf8'));

  expect(config).toStrictEqual({
    numStartups: 4,
    projects: {
      '/home/me/projects': { hasTrustDialogAccepted: true, allowedTools: [] },
      '/home/me/scratch': { hasTrustDialogAccepted: false },
      [root]: { hasTrustDialogAccepted: true },
    },
  });

  expect(readFileSync(daemon.marker, 'utf8').trimEnd().split('\n').at(-1)).toBe('start the task');
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('hello\n');
});

test.each([undefined, false])(
  'it leaves the user config byte for byte after a local clone launch with opt-in %s',
  async (enabled) => {
    await using daemon = await setupTest();

    const original = JSON.stringify({ projects: { '/home/me': { hasTrustDialogAccepted: true } } });

    writeFileSync(daemon.claudeConfig, original);

    await daemon.client.sendRequest('session.spawn', {
      ...(enabled === undefined ? {} : { trustClonedWorkspace: enabled }),
      cwd: join(daemon.dir, 'clone'),
      agent: 'claude',
      target: 'local',
      workspace: { kind: 'git', url: `file://${daemon.upstream}`, ref: 'main' },
    });

    await waitFor(() => {
      expect(existsSync(daemon.marker)).toBeTrue();

      return true;
    });

    expect(readFileSync(daemon.claudeConfig, 'utf8')).toBe(original);
  },
);

test('it trusts a local clone when the target defaults trust on', async () => {
  await using daemon = await setupTest({ targetTrust: true });

  const root = join(daemon.dir, 'clone');

  writeFileSync(daemon.claudeConfig, '{}');

  await daemon.client.sendRequest('session.spawn', {
    cwd: root,
    agent: 'claude',
    target: 'local',
    workspace: { kind: 'git', url: `file://${daemon.upstream}`, ref: 'main' },
  });

  await waitFor(() => {
    expect(existsSync(daemon.marker)).toBeTrue();

    return true;
  });

  const config: unknown = JSON.parse(readFileSync(daemon.claudeConfig, 'utf8'));

  expect(config).toStrictEqual({ projects: { [root]: { hasTrustDialogAccepted: true } } });
});

test('it refuses local trust for an existing folder without touching the user config', async () => {
  await using daemon = await setupTest();

  const folder = join(daemon.dir, 'existing');
  const original = '{"projects":{}}';

  mkdirSync(folder);
  writeFileSync(daemon.claudeConfig, original);

  const spawn = daemon.client.sendRequest('session.spawn', {
    trustClonedWorkspace: true,
    cwd: folder,
    agent: 'claude',
    target: 'local',
  });

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });

  await spawn.catch(() => null);

  expect(readFileSync(daemon.claudeConfig, 'utf8')).toBe(original);
  expect(existsSync(daemon.marker)).toBeFalse();
});

test('it takes the local trust back when the harness fails to start', async () => {
  await using daemon = await setupTest({ failHarnessAfterTrust: true });

  const root = join(daemon.dir, 'clone');

  const original = JSON.stringify(
    { projects: { '/home/me': { hasTrustDialogAccepted: true } } },
    null,
    2,
  );

  writeFileSync(daemon.claudeConfig, original);

  const spawn = daemon.client.sendRequest('session.spawn', {
    trustClonedWorkspace: true,
    cwd: root,
    agent: 'claude',
    target: 'local',
    workspace: { kind: 'git', url: `file://${daemon.upstream}`, ref: 'main' },
  });

  expect(spawn).rejects.toThrow('PTY spawn failed');

  await spawn.catch(() => null);

  expect(readFileSync(daemon.claudeConfig, 'utf8')).toBe(original);
  expect(existsSync(root)).toBeFalse();
});

test('it removes the clone and keeps the user config when the trust write fails', async () => {
  await using daemon = await setupTest();

  const root = join(daemon.dir, 'clone');

  writeFileSync(daemon.claudeConfig, '{"projects":');

  const spawn = daemon.client.sendRequest('session.spawn', {
    trustClonedWorkspace: true,
    cwd: root,
    agent: 'claude',
    target: 'local',
    workspace: { kind: 'git', url: `file://${daemon.upstream}`, ref: 'main' },
  });

  expect(spawn).rejects.toThrow();

  await spawn.catch(() => null);

  expect(readFileSync(daemon.claudeConfig, 'utf8')).toBe('{"projects":');
  expect(existsSync(root)).toBeFalse();
  expect(existsSync(daemon.marker)).toBeFalse();
});
