import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { GatewayAdapter } from '../agents/gateway-adapter';
import { parseConfig } from '../shared/config';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { createStubBin } from '../test-utils/create-stub-bin';
import { createStubImpPort } from '../test-utils/create-stub-imp-port';
import { createStubRecordingClaude } from '../test-utils/create-stub-recording-claude';
import { getAgentEntry } from '../test-utils/get-agent-entry';
import { getGatewayConfig } from '../test-utils/get-gateway-config';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { ImpProvider } from './imp-provider';

/**
 * A real daemon whose only target is the imp target `box`, over a stub
 * imp port, with two agents that sign in through impd's broker: `claude` on
 * a subscription and the gateway `glm`. Both run a fake Claude that appends
 * its arguments to the `starts` log when it starts. Beside it, `work` is a
 * git clone with one commit, holding `README.md`.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-project-settings-'));

  const git = await createGitFixture({ prefix: 'atc-project-settings-git-' });

  stack.use(git);

  // Both agent entries run this binary for every spawn.
  const fakeClaude = createStubRecordingClaude(tmp.dir);

  // The imp provider hands the guest this atc binary.
  const guestATC = createStubBin(tmp.dir, 'atc', '#!/bin/sh\nexit 0\n');
  const port = stack.use(createStubImpPort());

  // A brokered spawn needs a token that may grant each agent's secret, and
  // the secrets themselves.
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

  const provider = new ImpProvider(
    port,
    { guestDir: join(tmp.dir, 'guest'), guestATC },
    { atcBinary: null },
  );

  stack.defer(() => {
    provider.dispose();
  });

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

  const harness = await startTestDaemon({
    prefix: 'atc-project-settings-daemon-',
    options: () => ({
      adapters: [
        new ClaudeAdapter(getAgentEntry(config, 'claude'), config),
        new GatewayAdapter(getGatewayConfig(config, 'glm'), config),
      ],
      gitTransports: ['file'],
      targets: [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:test', provider }],
      defaultTarget: 'box',
    }),
  });

  stack.use(harness);

  const owned = stack.move();

  return {
    client: harness.client,
    port,
    starts: join(tmp.dir, 'claude-starts.log'),
    work: git.work,
    gitEnv: git.env,
    dir: tmp.dir,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
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
    await using ctx = await setupTest();

    mkdirSync(join(ctx.work, '.claude'));
    writeFileSync(join(ctx.work, file), content);

    await $`git add --all`.env(ctx.gitEnv).cwd(ctx.work).quiet();
    await $`git commit --quiet -m settings`.env(ctx.gitEnv).cwd(ctx.work).quiet();
    await $`git push --quiet origin main`.env(ctx.gitEnv).cwd(ctx.work).quiet();

    const root = join(ctx.dir, 'clone');

    const spawn = ctx.client.sendRequest('session.spawn', {
      cwd: root,
      agent: 'claude',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
      trustClonedWorkspace: true,
    });

    await spawn.catch(() => null);

    expect(spawn).rejects.toMatchObject({
      code: 'auth_target_unsupported',
      message: expect.not.toInclude('sk-ant-repo-secret'),
      data: {
        agent: 'claude',
        target: 'box',
        problem: 'project_settings_conflict',
        file: join(root, file),
        setting,
      },
    });

    expect(ctx.port.sessionRequests).toStrictEqual([]);
    expect(existsSync(root)).toBeFalse();
    expect(existsSync(ctx.starts)).toBeFalse();
  },
);

test('it refuses an untrusted subscription clone whose settings set apiKeyHelper', async () => {
  await using ctx = await setupTest();

  mkdirSync(join(ctx.work, '.claude'));
  writeFileSync(join(ctx.work, '.claude/settings.json'), '{"apiKeyHelper":"echo key"}');

  await $`git add .claude/settings.json`.env(ctx.gitEnv).cwd(ctx.work).quiet();
  await $`git commit --quiet -m settings`.env(ctx.gitEnv).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.gitEnv).cwd(ctx.work).quiet();

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'clone'),
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: {
      agent: 'claude',
      target: 'box',
      problem: 'project_settings_conflict',
      file: join(ctx.dir, 'clone', '.claude/settings.json'),
      setting: 'apiKeyHelper',
    },
  });

  expect(existsSync(ctx.starts)).toBeFalse();
});

test.each(['{"env": {', '[]', '[{"env":{"ANTHROPIC_API_KEY":"x"}}]'])(
  'it refuses a subscription clone whose settings file holds %s, which is not a JSON object',
  async (content) => {
    await using ctx = await setupTest();

    mkdirSync(join(ctx.work, '.claude'));
    writeFileSync(join(ctx.work, '.claude/settings.json'), content);

    await $`git add .claude/settings.json`.env(ctx.gitEnv).cwd(ctx.work).quiet();
    await $`git commit --quiet -m settings`.env(ctx.gitEnv).cwd(ctx.work).quiet();
    await $`git push --quiet origin main`.env(ctx.gitEnv).cwd(ctx.work).quiet();

    const spawn = ctx.client.sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'clone'),
      agent: 'claude',
      target: 'box',
      workspace: { kind: 'path', path: ctx.work },
      trustClonedWorkspace: true,
    });

    await spawn.catch(() => null);

    expect(spawn).rejects.toMatchObject({
      code: 'auth_target_unsupported',
      data: {
        agent: 'claude',
        target: 'box',
        problem: 'project_settings_conflict',
        file: join(ctx.dir, 'clone', '.claude/settings.json'),
        setting: '(unparseable)',
      },
    });

    expect(existsSync(ctx.starts)).toBeFalse();
  },
);

test('it refuses a subscription clone whose settings file is a dangling symlink', async () => {
  await using ctx = await setupTest();

  mkdirSync(join(ctx.work, '.claude'));
  symlinkSync(join(ctx.dir, 'missing', 'settings.json'), join(ctx.work, '.claude/settings.json'));

  await $`git add .claude/settings.json`.env(ctx.gitEnv).cwd(ctx.work).quiet();
  await $`git commit --quiet -m settings`.env(ctx.gitEnv).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.gitEnv).cwd(ctx.work).quiet();

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'clone'),
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    trustClonedWorkspace: true,
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: {
      agent: 'claude',
      target: 'box',
      problem: 'project_settings_unreadable',
      file: join(ctx.dir, 'clone', '.claude/settings.json'),
    },
  });

  expect(existsSync(ctx.starts)).toBeFalse();
});

test('it starts a trusted subscription clone whose settings set neither a credential nor a provider', async () => {
  await using ctx = await setupTest();

  mkdirSync(join(ctx.work, '.claude'));

  writeFileSync(
    join(ctx.work, '.claude/settings.json'),
    '{"env":{"DISABLE_TELEMETRY":"1"},"permissions":{"allow":["Bash(ls)"]}}',
  );

  await $`git add .claude/settings.json`.env(ctx.gitEnv).cwd(ctx.work).quiet();
  await $`git commit --quiet -m settings`.env(ctx.gitEnv).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.gitEnv).cwd(ctx.work).quiet();

  await ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'clone'),
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    trustClonedWorkspace: true,
  });

  await waitFor(() => {
    expect(existsSync(ctx.starts)).toBeTrue();
  });
});

test('it starts a trusted subscription clone with no project settings files', async () => {
  await using ctx = await setupTest();

  await ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'clone'),
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    trustClonedWorkspace: true,
  });

  await waitFor(() => {
    expect(existsSync(ctx.starts)).toBeTrue();
  });
});

test('it refuses a subscription launch in an existing folder whose local settings set a credential', async () => {
  await using ctx = await setupTest();

  mkdirSync(join(ctx.work, '.claude'));

  writeFileSync(
    join(ctx.work, '.claude/settings.local.json'),
    '{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-ant-repo-secret"}}',
  );

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'claude',
    target: 'box',
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: {
      agent: 'claude',
      target: 'box',
      problem: 'project_settings_conflict',
      file: join(ctx.work, '.claude/settings.local.json'),
      setting: 'env.ANTHROPIC_AUTH_TOKEN',
    },
  });

  expect(ctx.port.sessionRequests).toStrictEqual([]);
  expect(existsSync(ctx.starts)).toBeFalse();
});

test('it refuses a trusted gateway clone whose settings set apiKeyHelper', async () => {
  await using ctx = await setupTest();

  mkdirSync(join(ctx.work, '.claude'));
  writeFileSync(join(ctx.work, '.claude/settings.json'), '{"apiKeyHelper":"echo key"}');

  await $`git add .claude/settings.json`.env(ctx.gitEnv).cwd(ctx.work).quiet();
  await $`git commit --quiet -m settings`.env(ctx.gitEnv).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.gitEnv).cwd(ctx.work).quiet();

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'clone'),
    agent: 'glm',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    trustClonedWorkspace: true,
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: {
      agent: 'glm',
      target: 'box',
      problem: 'project_settings_conflict',
      file: join(ctx.dir, 'clone', '.claude/settings.json'),
      setting: 'apiKeyHelper',
    },
  });

  expect(existsSync(ctx.starts)).toBeFalse();
});

test('it refuses a subscription clone whose settings file is a symlink to an endless device', async () => {
  await using ctx = await setupTest();

  mkdirSync(join(ctx.work, '.claude'));
  symlinkSync('/dev/zero', join(ctx.work, '.claude/settings.json'));

  await $`git add .claude/settings.json`.env(ctx.gitEnv).cwd(ctx.work).quiet();
  await $`git commit --quiet -m settings`.env(ctx.gitEnv).cwd(ctx.work).quiet();
  await $`git push --quiet origin main`.env(ctx.gitEnv).cwd(ctx.work).quiet();

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'clone'),
    agent: 'claude',
    target: 'box',
    workspace: { kind: 'path', path: ctx.work },
    trustClonedWorkspace: true,
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: {
      agent: 'claude',
      target: 'box',
      problem: 'project_settings_unreadable',
      file: join(ctx.dir, 'clone', '.claude/settings.json'),
    },
  });

  expect(existsSync(ctx.starts)).toBeFalse();
});

test('it refuses a subscription launch in a subfolder whose repository root holds local settings with a credential', async () => {
  await using ctx = await setupTest();

  mkdirSync(join(ctx.work, '.claude'));
  mkdirSync(join(ctx.work, 'sub'));
  writeFileSync(join(ctx.work, '.claude/settings.local.json'), '{"apiKeyHelper":"echo key"}');

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: join(ctx.work, 'sub'),
    agent: 'claude',
    target: 'box',
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: {
      agent: 'claude',
      target: 'box',
      problem: 'project_settings_conflict',
      file: join(ctx.work, '.claude/settings.local.json'),
      setting: 'apiKeyHelper',
    },
  });

  expect(existsSync(ctx.starts)).toBeFalse();
});

test('it refuses a subscription launch in a worktree whose main checkout holds local settings with a credential', async () => {
  await using ctx = await setupTest();

  mkdirSync(join(ctx.work, '.claude'));

  const worktree = join(ctx.dir, 'worktree');

  await $`git worktree add --quiet ${worktree}`.env(ctx.gitEnv).cwd(ctx.work).quiet();

  writeFileSync(
    join(ctx.work, '.claude/settings.local.json'),
    '{"env":{"CLAUDE_CODE_USE_VERTEX":"1"}}',
  );

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: worktree,
    agent: 'claude',
    target: 'box',
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: {
      agent: 'claude',
      target: 'box',
      problem: 'project_settings_conflict',
      file: join(ctx.work, '.claude/settings.local.json'),
      setting: 'env.CLAUDE_CODE_USE_VERTEX',
    },
  });

  expect(existsSync(ctx.starts)).toBeFalse();
});

test('it refuses a launch path whose symlink and parent step resolve to a folder with conflicting settings', async () => {
  await using ctx = await setupTest();

  mkdirSync(join(ctx.work, '.claude'));
  mkdirSync(join(ctx.work, 'sub'));
  mkdirSync(join(ctx.dir, 'elsewhere'));
  symlinkSync(join(ctx.work, 'sub'), join(ctx.dir, 'elsewhere', 'link'));
  writeFileSync(join(ctx.work, '.claude/settings.json'), '{"env":{"ANTHROPIC_API_KEY":"x"}}');

  const spawn = ctx.client.sendRequest('session.spawn', {
    cwd: `${join(ctx.dir, 'elsewhere', 'link')}/..`,
    agent: 'claude',
    target: 'box',
  });

  await spawn.catch(() => null);

  expect(spawn).rejects.toMatchObject({
    code: 'auth_target_unsupported',
    data: {
      agent: 'claude',
      target: 'box',
      problem: 'project_settings_conflict',
      file: join(ctx.work, '.claude/settings.json'),
      setting: 'env.ANTHROPIC_API_KEY',
    },
  });

  expect(existsSync(ctx.starts)).toBeFalse();
});
