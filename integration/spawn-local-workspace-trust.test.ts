import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { startTestDaemon } from '@atc/app/test-utils/start-test-daemon';
import { parseConfig } from '@atc/config';
import { getAgentEntry } from '@atc/config/test-utils/get-agent-entry';
import { createGitFixture } from '@atc/core/test-utils/create-git-fixture';
import { getRecord } from '@atc/core/test-utils/get-record';
import { getString } from '@atc/core/test-utils/get-string';
import { createLocalPTYProvider } from '@atc/execution-local';
import { createStubPTYProvider } from '@atc/execution-local/test-utils/create-stub-pty-provider';
import {
  buildLocalScratchPath,
  createClaudeAdapter,
  createGatewayAdapter,
} from '@atc/harness-claude';
import { buildTrustedClaudeConfig } from '@atc/harness-claude/test-utils/build-trusted-claude-config';
import { createStubRecordingClaude } from '@atc/harness-claude/test-utils/create-stub-recording-claude';
import { getGatewayConfig } from '@atc/harness-claude/test-utils/get-gateway-config';
import { buildMockHostServices } from '@atc/plugin-api/test-utils/build-mock-host-services';
import { toSessionID } from '@atcx/contract';
import { waitFor } from '@zgeoff/testing';
import invariant from 'tiny-invariant';
import { SHIPPED_HARNESS_PLUGINS } from '../packages/app/src/plugins/shipped-harness-plugins';

async function setupTest() {
  const git = await createGitFixture({ prefix: 'atc-local-workspace-trust-' });

  const homeDir = join(git.directory, 'home');
  const stateDir = join(git.directory, 'state');
  const fakeClaude = createStubRecordingClaude(join(git.directory, 'bin'));

  mkdirSync(homeDir);

  return {
    directory: git.directory,
    upstream: git.upstream,
    work: git.work,
    homeDir,
    stateDir,
    fakeClaude,
    starts: join(git.directory, 'bin', 'claude-starts.log'),
    claudeConfig: join(homeDir, '.claude.json'),
  };
}

test('it trusts only the resolved clone root in the user config after an opted-in local launch', async () => {
  const ctx = await setupTest();

  const atcConfig = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: ctx.fakeClaude },
      plain: {
        kind: 'claude',
        baseURL: 'https://gateway.example.com',
        bin: ctx.fakeClaude,
      },
    },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: [
        createClaudeAdapter(
          getAgentEntry(atcConfig, 'claude'),
          atcConfig,
          buildMockHostServices(),
          {
            homeDir: ctx.homeDir,
            stateDir: ctx.stateDir,
          },
        ),
        createGatewayAdapter(
          getGatewayConfig(atcConfig, 'plain'),
          atcConfig,
          buildMockHostServices(),
        ),
      ],
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
      defaultTarget: 'local',
    }),
  });

  const parent = join(ctx.directory, 'physical');
  const alias = join(ctx.directory, 'alias');

  mkdirSync(parent);
  symlinkSync(parent, alias);
  mkdirSync(join(parent, 'sibling'));

  const original = {
    numStartups: 4,
    projects: {
      '/home/me/projects': { hasTrustDialogAccepted: true, allowedTools: [] },
      '/home/me/scratch': { hasTrustDialogAccepted: false },
    },
  };

  writeFileSync(ctx.claudeConfig, JSON.stringify(original, null, 2));

  const spawned = await daemon.client.sendRequest('session.spawn', {
    trustClonedWorkspace: true,
    cwd: join(alias, 'clone'),
    agent: 'claude',
    target: 'local',
    prompt: 'start the task',
    workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
  });

  await waitFor(() => {
    expect(readFileSync(ctx.starts, 'utf8').trimEnd().split('\n').at(-1)).toBe('start the task');
  });

  const session = toSessionID(getString(getRecord(spawned, 'session'), 'id'));

  expect(JSON.parse(readFileSync(ctx.claudeConfig, 'utf8'))).toStrictEqual(
    buildTrustedClaudeConfig(original, [
      buildLocalScratchPath(session, ctx.stateDir),
      join(parent, 'clone'),
    ]),
  );

  expect(readFileSync(join(parent, 'clone', 'README.md'), 'utf8')).toBe(
    readFileSync(join(ctx.work, 'README.md'), 'utf8'),
  );
});

test('it adds no clone trust to the user config after a local clone launch with no opt-in', async () => {
  const ctx = await setupTest();

  const atcConfig = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: ctx.fakeClaude },
      plain: {
        kind: 'claude',
        baseURL: 'https://gateway.example.com',
        bin: ctx.fakeClaude,
      },
    },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: [
        createClaudeAdapter(
          getAgentEntry(atcConfig, 'claude'),
          atcConfig,
          buildMockHostServices(),
          {
            homeDir: ctx.homeDir,
            stateDir: ctx.stateDir,
          },
        ),
        createGatewayAdapter(
          getGatewayConfig(atcConfig, 'plain'),
          atcConfig,
          buildMockHostServices(),
        ),
      ],
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
      defaultTarget: 'local',
    }),
  });

  const original = {
    projects: { '/home/me': { hasTrustDialogAccepted: true } },
  };

  writeFileSync(ctx.claudeConfig, JSON.stringify(original));

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.directory, 'clone'),
    agent: 'claude',
    target: 'local',
    workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
  });

  await waitFor(() => {
    expect(existsSync(ctx.starts)).toBeTrue();
  });

  const session = toSessionID(getString(getRecord(spawned, 'session'), 'id'));

  expect(JSON.parse(readFileSync(ctx.claudeConfig, 'utf8'))).toStrictEqual(
    buildTrustedClaudeConfig(original, [buildLocalScratchPath(session, ctx.stateDir)]),
  );
});

test('it adds no clone trust to the user config after a local clone launch that opts out', async () => {
  const ctx = await setupTest();

  const atcConfig = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: ctx.fakeClaude },
      plain: {
        kind: 'claude',
        baseURL: 'https://gateway.example.com',
        bin: ctx.fakeClaude,
      },
    },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: [
        createClaudeAdapter(
          getAgentEntry(atcConfig, 'claude'),
          atcConfig,
          buildMockHostServices(),
          {
            homeDir: ctx.homeDir,
            stateDir: ctx.stateDir,
          },
        ),
        createGatewayAdapter(
          getGatewayConfig(atcConfig, 'plain'),
          atcConfig,
          buildMockHostServices(),
        ),
      ],
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
      defaultTarget: 'local',
    }),
  });

  const original = {
    projects: { '/home/me': { hasTrustDialogAccepted: true } },
  };

  writeFileSync(ctx.claudeConfig, JSON.stringify(original));

  const spawned = await daemon.client.sendRequest('session.spawn', {
    trustClonedWorkspace: false,
    cwd: join(ctx.directory, 'clone'),
    agent: 'claude',
    target: 'local',
    workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
  });

  await waitFor(() => {
    expect(existsSync(ctx.starts)).toBeTrue();
  });

  const session = toSessionID(getString(getRecord(spawned, 'session'), 'id'));

  expect(JSON.parse(readFileSync(ctx.claudeConfig, 'utf8'))).toStrictEqual(
    buildTrustedClaudeConfig(original, [buildLocalScratchPath(session, ctx.stateDir)]),
  );
});

test('it trusts a local clone when the target defaults trust on', async () => {
  const ctx = await setupTest();

  const atcConfig = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: ctx.fakeClaude },
      plain: {
        kind: 'claude',
        baseURL: 'https://gateway.example.com',
        bin: ctx.fakeClaude,
      },
    },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: [
        createClaudeAdapter(
          getAgentEntry(atcConfig, 'claude'),
          atcConfig,
          buildMockHostServices(),
          {
            homeDir: ctx.homeDir,
            stateDir: ctx.stateDir,
          },
        ),
        createGatewayAdapter(
          getGatewayConfig(atcConfig, 'plain'),
          atcConfig,
          buildMockHostServices(),
        ),
      ],
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: { trustClonedWorkspace: true },
          identity: 'local:test',
          provider: createLocalPTYProvider(),
        },
      ],
      defaultTarget: 'local',
    }),
  });

  writeFileSync(ctx.claudeConfig, '{}');

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.directory, 'clone'),
    agent: 'claude',
    target: 'local',
    workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
  });

  await waitFor(() => {
    expect(existsSync(ctx.starts)).toBeTrue();
  });

  const session = toSessionID(getString(getRecord(spawned, 'session'), 'id'));

  expect(JSON.parse(readFileSync(ctx.claudeConfig, 'utf8'))).toStrictEqual(
    buildTrustedClaudeConfig({}, [
      buildLocalScratchPath(session, ctx.stateDir),
      join(ctx.directory, 'clone'),
    ]),
  );
});

test('it refuses local trust for an existing folder', async () => {
  const ctx = await setupTest();

  const atcConfig = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: ctx.fakeClaude },
      plain: {
        kind: 'claude',
        baseURL: 'https://gateway.example.com',
        bin: ctx.fakeClaude,
      },
    },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: [
        createClaudeAdapter(
          getAgentEntry(atcConfig, 'claude'),
          atcConfig,
          buildMockHostServices(),
          {
            homeDir: ctx.homeDir,
            stateDir: ctx.stateDir,
          },
        ),
        createGatewayAdapter(
          getGatewayConfig(atcConfig, 'plain'),
          atcConfig,
          buildMockHostServices(),
        ),
      ],
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
      defaultTarget: 'local',
    }),
  });

  mkdirSync(join(ctx.directory, 'existing'));
  writeFileSync(ctx.claudeConfig, '{"projects":{}}');

  expect(
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.directory, 'existing'),
      agent: 'claude',
      target: 'local',
    }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test("it trusts a local session's own scratch folder in the user config before the harness starts", async () => {
  const ctx = await setupTest();

  const atcConfig = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: { claude: { bin: ctx.fakeClaude } },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: [
        createClaudeAdapter(
          getAgentEntry(atcConfig, 'claude'),
          atcConfig,
          buildMockHostServices(),
          {
            homeDir: ctx.homeDir,
            stateDir: ctx.stateDir,
          },
        ),
      ],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: createLocalPTYProvider(),
        },
      ],
      defaultTarget: 'local',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: ctx.work,
    agent: 'claude',
    target: 'local',
  });

  await waitFor(() => {
    expect(existsSync(ctx.starts)).toBeTrue();
  });

  const session = toSessionID(getString(getRecord(spawned, 'session'), 'id'));

  expect(JSON.parse(readFileSync(ctx.claudeConfig, 'utf8'))).toStrictEqual(
    buildTrustedClaudeConfig({}, [buildLocalScratchPath(session, ctx.stateDir)]),
  );
});

test('it leaves the user config and starts nothing when it refuses local trust for an existing folder', async () => {
  const ctx = await setupTest();

  const atcConfig = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: ctx.fakeClaude },
      plain: {
        kind: 'claude',
        baseURL: 'https://gateway.example.com',
        bin: ctx.fakeClaude,
      },
    },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: [
        createClaudeAdapter(
          getAgentEntry(atcConfig, 'claude'),
          atcConfig,
          buildMockHostServices(),
          {
            homeDir: ctx.homeDir,
            stateDir: ctx.stateDir,
          },
        ),
        createGatewayAdapter(
          getGatewayConfig(atcConfig, 'plain'),
          atcConfig,
          buildMockHostServices(),
        ),
      ],
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
      defaultTarget: 'local',
    }),
  });

  mkdirSync(join(ctx.directory, 'existing'));
  writeFileSync(ctx.claudeConfig, '{"projects":{}}');

  await Promise.allSettled([
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.directory, 'existing'),
      agent: 'claude',
      target: 'local',
    }),
  ]);

  expect(readFileSync(ctx.claudeConfig, 'utf8')).toBe('{"projects":{}}');
  expect(existsSync(ctx.starts)).toBe(false);
});

test('it refuses a local launch whose harness fails to start after the trust write', async () => {
  const ctx = await setupTest();

  const atcConfig = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: ctx.fakeClaude },
      plain: {
        kind: 'claude',
        baseURL: 'https://gateway.example.com',
        bin: ctx.fakeClaude,
      },
    },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: [
        createClaudeAdapter(
          getAgentEntry(atcConfig, 'claude'),
          atcConfig,
          buildMockHostServices(),
          {
            homeDir: ctx.homeDir,
            stateDir: ctx.stateDir,
          },
        ),
        createGatewayAdapter(
          getGatewayConfig(atcConfig, 'plain'),
          atcConfig,
          buildMockHostServices(),
        ),
      ],
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: createStubPTYProvider({
            onSpawn: () => {
              throw new Error('PTY spawn failed: the host refused the harness');
            },
          }),
        },
      ],
      defaultTarget: 'local',
    }),
  });

  writeFileSync(ctx.claudeConfig, '{"projects":{}}');

  expect(
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.directory, 'clone'),
      agent: 'claude',
      target: 'local',
      workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
    }),
  ).rejects.toMatchObject({
    code: 'internal',
    message: 'PTY spawn failed: the host refused the harness',
  });
});

test('it takes the local trust back and removes the clone when the harness fails to start', async () => {
  const ctx = await setupTest();

  const atcConfig = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: ctx.fakeClaude },
      plain: {
        kind: 'claude',
        baseURL: 'https://gateway.example.com',
        bin: ctx.fakeClaude,
      },
    },
  });

  const atSpawn: unknown[] = [];

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: [
        createClaudeAdapter(
          getAgentEntry(atcConfig, 'claude'),
          atcConfig,
          buildMockHostServices(),
          {
            homeDir: ctx.homeDir,
            stateDir: ctx.stateDir,
          },
        ),
        createGatewayAdapter(
          getGatewayConfig(atcConfig, 'plain'),
          atcConfig,
          buildMockHostServices(),
        ),
      ],
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: createStubPTYProvider({
            onSpawn: () => {
              atSpawn.push(JSON.parse(readFileSync(ctx.claudeConfig, 'utf8')));
              throw new Error('PTY spawn failed: the host refused the harness');
            },
          }),
        },
      ],
      defaultTarget: 'local',
    }),
  });

  const original = {
    projects: { '/home/me': { hasTrustDialogAccepted: true } },
  };

  writeFileSync(ctx.claudeConfig, JSON.stringify(original, null, 2));

  await Promise.allSettled([
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.directory, 'clone'),
      agent: 'claude',
      target: 'local',
      workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
    }),
  ]);

  const [session, ...others] = readdirSync(join(ctx.stateDir, 'sessions'));

  invariant(session !== undefined && others.length === 0, 'expected one session folder');

  const scratch = buildLocalScratchPath(toSessionID(session), ctx.stateDir);

  expect(atSpawn).toStrictEqual([
    buildTrustedClaudeConfig(original, [scratch, join(ctx.directory, 'clone')]),
  ]);

  expect(JSON.parse(readFileSync(ctx.claudeConfig, 'utf8'))).toStrictEqual(
    buildTrustedClaudeConfig(original, [scratch]),
  );

  expect(existsSync(join(ctx.directory, 'clone'))).toBe(false);
});

test('it refuses a local launch whose trust write fails', async () => {
  const ctx = await setupTest();

  const atcConfig = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: ctx.fakeClaude },
      plain: {
        kind: 'claude',
        baseURL: 'https://gateway.example.com',
        bin: ctx.fakeClaude,
      },
    },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: [
        createClaudeAdapter(
          getAgentEntry(atcConfig, 'claude'),
          atcConfig,
          buildMockHostServices(),
          {
            homeDir: ctx.homeDir,
            stateDir: ctx.stateDir,
          },
        ),
        createGatewayAdapter(
          getGatewayConfig(atcConfig, 'plain'),
          atcConfig,
          buildMockHostServices(),
        ),
      ],
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
      defaultTarget: 'local',
    }),
  });

  writeFileSync(ctx.claudeConfig, '{"projects":');

  expect(
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.directory, 'clone'),
      agent: 'claude',
      target: 'local',
      workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
    }),
  ).rejects.toMatchObject({ code: 'internal' });
});

test('it removes the clone, keeps the user config, and starts nothing when the trust write fails', async () => {
  const ctx = await setupTest();

  const atcConfig = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: ctx.fakeClaude },
      plain: {
        kind: 'claude',
        baseURL: 'https://gateway.example.com',
        bin: ctx.fakeClaude,
      },
    },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: [
        createClaudeAdapter(
          getAgentEntry(atcConfig, 'claude'),
          atcConfig,
          buildMockHostServices(),
          {
            homeDir: ctx.homeDir,
            stateDir: ctx.stateDir,
          },
        ),
        createGatewayAdapter(
          getGatewayConfig(atcConfig, 'plain'),
          atcConfig,
          buildMockHostServices(),
        ),
      ],
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
      defaultTarget: 'local',
    }),
  });

  writeFileSync(ctx.claudeConfig, '{"projects":');

  await Promise.allSettled([
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.directory, 'clone'),
      agent: 'claude',
      target: 'local',
      workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
    }),
  ]);

  expect(readFileSync(ctx.claudeConfig, 'utf8')).toBe('{"projects":');
  expect(existsSync(join(ctx.directory, 'clone'))).toBe(false);
  expect(existsSync(ctx.starts)).toBe(false);
});

test('it refuses local trust for a gateway', async () => {
  const ctx = await setupTest();

  const atcConfig = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: ctx.fakeClaude },
      plain: {
        kind: 'claude',
        baseURL: 'https://gateway.example.com',
        bin: ctx.fakeClaude,
      },
    },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: [
        createClaudeAdapter(
          getAgentEntry(atcConfig, 'claude'),
          atcConfig,
          buildMockHostServices(),
          {
            homeDir: ctx.homeDir,
            stateDir: ctx.stateDir,
          },
        ),
        createGatewayAdapter(
          getGatewayConfig(atcConfig, 'plain'),
          atcConfig,
          buildMockHostServices(),
        ),
      ],
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
      defaultTarget: 'local',
    }),
  });

  writeFileSync(ctx.claudeConfig, '{"projects":{}}');

  expect(
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.directory, 'clone'),
      agent: 'plain',
      target: 'local',
      workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
    }),
  ).rejects.toMatchObject({
    code: 'unsupported',
    message:
      'trustClonedWorkspace requires stock Claude on the local target, or stock Claude, a Claude gateway, or Codex signed in through the broker on a remote target that can trust a clone',
  });
});

test('it refuses local trust for a gateway before cloning or touching the user config', async () => {
  const ctx = await setupTest();

  const atcConfig = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: ctx.fakeClaude },
      plain: {
        kind: 'claude',
        baseURL: 'https://gateway.example.com',
        bin: ctx.fakeClaude,
      },
    },
  });

  const daemon = await startTestDaemon({
    options: () => ({
      adapters: [
        createClaudeAdapter(
          getAgentEntry(atcConfig, 'claude'),
          atcConfig,
          buildMockHostServices(),
          {
            homeDir: ctx.homeDir,
            stateDir: ctx.stateDir,
          },
        ),
        createGatewayAdapter(
          getGatewayConfig(atcConfig, 'plain'),
          atcConfig,
          buildMockHostServices(),
        ),
      ],
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
      defaultTarget: 'local',
    }),
  });

  writeFileSync(ctx.claudeConfig, '{"projects":{}}');

  await Promise.allSettled([
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.directory, 'clone'),
      agent: 'plain',
      target: 'local',
      workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
    }),
  ]);

  expect(readFileSync(ctx.claudeConfig, 'utf8')).toBe('{"projects":{}}');
  expect(existsSync(join(ctx.directory, 'clone'))).toBe(false);
  expect(existsSync(ctx.starts)).toBe(false);
});
