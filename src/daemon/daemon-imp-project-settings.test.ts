import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { FixtureImpPort } from '../../test/fixture-imp-port';
import { getAgentEntry } from '../../test/get-agent-entry';
import { getGatewayConfig } from '../../test/get-gateway-config';
import { setupTempDir } from '../../test/setup-temp-dir';
import { waitFor } from '../../test/wait-for';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { GatewayAdapter } from '../agents/gateway-adapter';
import { DaemonClient } from '../client/daemon-client';
import { parseConfig } from '../shared/config';
import { startDaemon } from './daemon';
import { ImpProvider } from './imp-provider';

async function setupTest() {
  const tmp = setupTempDir('atc-project-settings-');
  const guestDir = join(tmp.dir, 'guest');
  const marker = join(tmp.dir, 'started');
  const fakeClaude = join(tmp.dir, 'fake-claude');
  const guestATC = join(tmp.dir, 'atc');
  const upstream = join(tmp.dir, 'upstream.git');
  const work = join(tmp.dir, 'work');

  const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`
    .env(gitEnv)
    .quiet();

  await $`git clone --quiet --template= ${upstream} ${work}`.env(gitEnv).quiet();
  await $`git config user.name atc`.env(gitEnv).cwd(work).quiet();
  await $`git config user.email atc@example.com`.env(gitEnv).cwd(work).quiet();
  await $`git config commit.gpgsign false`.env(gitEnv).cwd(work).quiet();

  writeFileSync(join(work, 'README.md'), 'hello\n');
  mkdirSync(join(work, '.claude'));

  writeFileSync(fakeClaude, `#!/bin/sh\necho started >> "${marker}"\nexec sleep 30\n`, {
    mode: 0o755,
  });

  writeFileSync(guestATC, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const port = new FixtureImpPort();

  port.setIdentity({
    kind: 'token',
    name: 'atc-runtime',
    scope: 'manage',
    imps: ['atc-*'],
    grantable: ['claude-setup-token', 'glm'],
  });

  port.createSecret('claude-setup-token', 'custom', [
    { host: 'api.anthropic.com', header: 'authorization', scheme: 'bearer' },
  ]);

  port.createSecret('glm', 'custom', [
    { host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
  ]);

  const provider = new ImpProvider(port, { guestDir, guestATC }, { atcBinary: null });

  const config = parseConfig({
    authProfiles: {
      claude: {
        secret: 'claude-setup-token',
        host: 'api.anthropic.com',
        header: 'authorization',
        scheme: 'bearer',
      },
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
    agents: {
      claude: { bin: fakeClaude, auth: { profiles: ['claude'] } },
      glm: {
        kind: 'claude',
        bin: fakeClaude,
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: {
          profiles: ['glm'],
          placeholderEnv: { ANTHROPIC_AUTH_TOKEN: 'imp-broker-placeholder' },
        },
      },
    },
  });

  const socketPath = join(tmp.dir, 'daemon.sock');

  const daemon = await startDaemon({
    socketPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapters: [
      new ClaudeAdapter(getAgentEntry(config, 'claude'), config),
      new GatewayAdapter(getGatewayConfig(config, 'glm'), config),
    ],
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    gitTransports: ['file'],
    targets: [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider }],
    defaultTarget: 'box',
  });

  const client = await DaemonClient.open(socketPath);

  await client.sendHello('atc/test-build');

  return {
    client,
    port,
    marker,
    work,
    gitEnv,
    dir: tmp.dir,
    async [Symbol.asyncDispose]() {
      client.stop();

      await daemon.stop();

      provider.dispose();
      port[Symbol.dispose]();
      tmp[Symbol.dispose]();
    },
  };
}

test.each([
  [
    '.claude/settings.json',
    'env.ANTHROPIC_API_KEY',
    '{"env":{"ANTHROPIC_API_KEY":"sk-ant-repo-secret"}}',
  ],
  ['.claude/settings.json', 'apiKeyHelper', '{"apiKeyHelper":"echo sk-ant-repo-secret"}'],
  [
    '.claude/settings.local.json',
    'env.ANTHROPIC_API_KEY',
    '{"env":{"ANTHROPIC_API_KEY":"sk-ant-repo-secret"}}',
  ],
  ['.claude/settings.local.json', 'apiKeyHelper', '{"apiKeyHelper":"echo sk-ant-repo-secret"}'],
  [
    '.claude/settings.json',
    'env.ANTHROPIC_BASE_URL',
    '{"env":{"ANTHROPIC_BASE_URL":"https://example.com"}}',
  ],
  [
    '.claude/settings.json',
    'env.CLAUDE_CODE_USE_BEDROCK',
    '{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}',
  ],
  [
    '.claude/settings.json',
    'env.HTTPS_PROXY',
    '{"env":{"HTTPS_PROXY":"http://proxy.example.com"}}',
  ],
] as const)(
  'it refuses a trusted subscription clone whose %s sets %s and starts nothing',
  async (file, setting, content) => {
    await using daemon = await setupTest();

    writeFileSync(join(daemon.work, file), content);

    await $`git add -f ${file} README.md`.env(daemon.gitEnv).cwd(daemon.work).quiet();
    await $`git commit --quiet -m settings`.env(daemon.gitEnv).cwd(daemon.work).quiet();
    await $`git push --quiet origin main`.env(daemon.gitEnv).cwd(daemon.work).quiet();

    const root = join(daemon.dir, 'clone');

    const spawn = daemon.client.sendRequest('session.spawn', {
      cwd: root,
      agent: 'claude',
      target: 'box',
      workspace: { kind: 'path', path: daemon.work },
      trustClonedWorkspace: true,
    });

    expect(spawn).rejects.toMatchObject({
      code: 'auth_target_unsupported',
      message: expect.not.toInclude('sk-ant-repo-secret'),
      data: { agent: 'claude', target: 'box', problem: 'project_settings_conflict', file, setting },
    });

    await spawn.catch(() => null);

    expect(daemon.port.sessionRequests).toStrictEqual([]);
    expect(existsSync(root)).toBeFalse();
    expect(existsSync(daemon.marker)).toBeFalse();
  },
);

test('it refuses an untrusted subscription clone whose settings set apiKeyHelper', async () => {
  await using daemon = await setupTest();

  writeFileSync(join(daemon.work, '.claude/settings.json'), '{"apiKeyHelper":"echo key"}');

  await $`git add .claude/settings.json README.md`.env(daemon.gitEnv).cwd(daemon.work).quiet();
  await $`git commit --quiet -m settings`.env(daemon.gitEnv).cwd(daemon.work).quiet();
  await $`git push --quiet origin main`.env(daemon.gitEnv).cwd(daemon.work).quiet();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'clone'),
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
  });

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { problem: 'project_settings_conflict', setting: 'apiKeyHelper' },
  });

  await spawn.catch(() => null);

  expect(existsSync(daemon.marker)).toBeFalse();
});

test('it refuses a subscription clone whose settings file is not a JSON object', async () => {
  await using daemon = await setupTest();

  writeFileSync(join(daemon.work, '.claude/settings.json'), '{"env": {');

  await $`git add .claude/settings.json README.md`.env(daemon.gitEnv).cwd(daemon.work).quiet();
  await $`git commit --quiet -m settings`.env(daemon.gitEnv).cwd(daemon.work).quiet();
  await $`git push --quiet origin main`.env(daemon.gitEnv).cwd(daemon.work).quiet();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'clone'),
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
    trustClonedWorkspace: true,
  });

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { problem: 'project_settings_conflict', setting: '(unparseable)' },
  });

  await spawn.catch(() => null);

  expect(existsSync(daemon.marker)).toBeFalse();
});

test('it refuses a subscription clone whose settings file is a dangling symlink', async () => {
  await using daemon = await setupTest();

  await $`ln -s /nonexistent/settings.json .claude/settings.json`.cwd(daemon.work).quiet();
  await $`git add .claude/settings.json README.md`.env(daemon.gitEnv).cwd(daemon.work).quiet();
  await $`git commit --quiet -m settings`.env(daemon.gitEnv).cwd(daemon.work).quiet();
  await $`git push --quiet origin main`.env(daemon.gitEnv).cwd(daemon.work).quiet();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'clone'),
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
    trustClonedWorkspace: true,
  });

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { problem: 'project_settings_unreadable', file: '.claude/settings.json' },
  });

  await spawn.catch(() => null);

  expect(existsSync(daemon.marker)).toBeFalse();
});

test('it starts a trusted subscription clone whose settings set neither a credential nor a provider', async () => {
  await using daemon = await setupTest();

  writeFileSync(
    join(daemon.work, '.claude/settings.json'),
    '{"env":{"DISABLE_TELEMETRY":"1"},"permissions":{"allow":["Bash(ls)"]}}',
  );

  await $`git add .claude/settings.json README.md`.env(daemon.gitEnv).cwd(daemon.work).quiet();
  await $`git commit --quiet -m settings`.env(daemon.gitEnv).cwd(daemon.work).quiet();
  await $`git push --quiet origin main`.env(daemon.gitEnv).cwd(daemon.work).quiet();

  await daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'clone'),
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
    trustClonedWorkspace: true,
  });

  await waitFor(() => {
    expect(existsSync(daemon.marker)).toBeTrue();

    return true;
  });
});

test('it starts a trusted subscription clone with no project settings files', async () => {
  await using daemon = await setupTest();

  await $`git add README.md`.env(daemon.gitEnv).cwd(daemon.work).quiet();
  await $`git commit --quiet -m initial`.env(daemon.gitEnv).cwd(daemon.work).quiet();
  await $`git push --quiet origin main`.env(daemon.gitEnv).cwd(daemon.work).quiet();

  await daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'clone'),
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
    trustClonedWorkspace: true,
  });

  await waitFor(() => {
    expect(existsSync(daemon.marker)).toBeTrue();

    return true;
  });
});

test('it refuses a subscription launch in an existing folder whose local settings set a credential', async () => {
  await using daemon = await setupTest();

  writeFileSync(
    join(daemon.work, '.claude/settings.local.json'),
    '{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-ant-repo-secret"}}',
  );

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: daemon.work,
    agent: 'claude',
    target: 'box',
  });

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: {
      problem: 'project_settings_conflict',
      file: '.claude/settings.local.json',
      setting: 'env.ANTHROPIC_AUTH_TOKEN',
    },
  });

  await spawn.catch(() => null);

  expect(daemon.port.sessionRequests).toStrictEqual([]);
  expect(existsSync(daemon.marker)).toBeFalse();
});

test('it refuses a trusted gateway clone whose settings set apiKeyHelper', async () => {
  await using daemon = await setupTest();

  writeFileSync(join(daemon.work, '.claude/settings.json'), '{"apiKeyHelper":"echo key"}');

  await $`git add .claude/settings.json README.md`.env(daemon.gitEnv).cwd(daemon.work).quiet();
  await $`git commit --quiet -m settings`.env(daemon.gitEnv).cwd(daemon.work).quiet();
  await $`git push --quiet origin main`.env(daemon.gitEnv).cwd(daemon.work).quiet();

  const spawn = daemon.client.sendRequest('session.spawn', {
    cwd: join(daemon.dir, 'clone'),
    agent: 'glm',
    target: 'box',
    workspace: { kind: 'path', path: daemon.work },
    trustClonedWorkspace: true,
  });

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: { agent: 'glm', problem: 'project_settings_conflict', setting: 'apiKeyHelper' },
  });

  await spawn.catch(() => null);

  expect(existsSync(daemon.marker)).toBeFalse();
});
