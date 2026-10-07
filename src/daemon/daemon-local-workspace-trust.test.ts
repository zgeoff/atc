import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAdapter } from '../agents/claude-adapter';
import { GatewayAdapter } from '../agents/gateway-adapter';
import { parseConfig } from '../shared/config';
import { buildStubPTYProvider } from '../test-utils/build-stub-pty-provider';
import { createGitFixture } from '../test-utils/create-git-fixture';
import { createStubRecordingClaude } from '../test-utils/create-stub-recording-claude';
import { getAgentEntry } from '../test-utils/get-agent-entry';
import { getGatewayConfig } from '../test-utils/get-gateway-config';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { LocalPTYProvider } from './local-pty-provider';

/**
 * What a local clone launch needs before its daemon starts: a git fixture
 * whose upstream a spawn clones, a user home of its own for the Claude
 * config, a stock Claude adapter whose CLI is a script that appends its
 * arguments to its `starts` log and then sleeps, and a gateway adapter named
 * `plain`. Each test starts its own daemon with the adapters and the target
 * options it needs.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const git = await createGitFixture({ prefix: 'atc-local-workspace-trust-' });

  stack.use(git);

  const homeDir = join(git.dir, 'home');
  const fakeClaude = createStubRecordingClaude(join(git.dir, 'bin'));

  // The adapter reads and writes the user's Claude config under this home.
  mkdirSync(homeDir);

  const config = parseConfig({
    claudeBin: fakeClaude,
    gateways: { plain: { baseURL: 'https://gateway.example.com' } },
  });

  const owned = stack.move();

  return {
    dir: git.dir,
    upstream: git.upstream,
    work: git.work,
    starts: join(git.dir, 'bin', 'claude-starts.log'),
    claudeConfig: join(homeDir, '.claude.json'),
    adapters: [
      new ClaudeAdapter(getAgentEntry(config, 'claude'), config, null, undefined, { homeDir }),
      new GatewayAdapter(getGatewayConfig(config, 'plain'), config),
    ],
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it trusts only the resolved clone root in the user config after an opted-in local launch', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: ctx.adapters,
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: new LocalPTYProvider(),
        },
      ],
      defaultTarget: 'local',
    }),
  });

  const parent = join(ctx.dir, 'physical');
  const alias = join(ctx.dir, 'alias');

  mkdirSync(parent);
  symlinkSync(parent, alias);
  mkdirSync(join(parent, 'sibling'));

  writeFileSync(
    ctx.claudeConfig,
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
    workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
  });

  await waitFor(() => {
    expect(readFileSync(ctx.starts, 'utf8').trimEnd().split('\n').at(-1)).toBe('start the task');
  });

  const config: unknown = JSON.parse(readFileSync(ctx.claudeConfig, 'utf8'));

  expect({
    config,
    readme: readFileSync(join(parent, 'clone', 'README.md'), 'utf8'),
  }).toStrictEqual({
    config: {
      numStartups: 4,
      projects: {
        '/home/me/projects': { hasTrustDialogAccepted: true, allowedTools: [] },
        '/home/me/scratch': { hasTrustDialogAccepted: false },
        [join(parent, 'clone')]: { hasTrustDialogAccepted: true },
      },
    },
    readme: readFileSync(join(ctx.work, 'README.md'), 'utf8'),
  });
});

test('it leaves the user config byte for byte after a local clone launch with no opt-in', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: ctx.adapters,
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: new LocalPTYProvider(),
        },
      ],
      defaultTarget: 'local',
    }),
  });

  writeFileSync(
    ctx.claudeConfig,
    JSON.stringify({ projects: { '/home/me': { hasTrustDialogAccepted: true } } }),
  );

  await daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'clone'),
    agent: 'claude',
    target: 'local',
    workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
  });

  await waitFor(() => {
    expect(existsSync(ctx.starts)).toBeTrue();
  });

  expect(readFileSync(ctx.claudeConfig, 'utf8')).toBe(
    JSON.stringify({ projects: { '/home/me': { hasTrustDialogAccepted: true } } }),
  );
});

test('it leaves the user config byte for byte after a local clone launch that opts out', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: ctx.adapters,
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: new LocalPTYProvider(),
        },
      ],
      defaultTarget: 'local',
    }),
  });

  writeFileSync(
    ctx.claudeConfig,
    JSON.stringify({ projects: { '/home/me': { hasTrustDialogAccepted: true } } }),
  );

  await daemon.client.sendRequest('session.spawn', {
    trustClonedWorkspace: false,
    cwd: join(ctx.dir, 'clone'),
    agent: 'claude',
    target: 'local',
    workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
  });

  await waitFor(() => {
    expect(existsSync(ctx.starts)).toBeTrue();
  });

  expect(readFileSync(ctx.claudeConfig, 'utf8')).toBe(
    JSON.stringify({ projects: { '/home/me': { hasTrustDialogAccepted: true } } }),
  );
});

test('it trusts a local clone when the target defaults trust on', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: ctx.adapters,
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: { trustClonedWorkspace: true },
          identity: 'local:test',
          provider: new LocalPTYProvider(),
        },
      ],
      defaultTarget: 'local',
    }),
  });

  writeFileSync(ctx.claudeConfig, '{}');

  await daemon.client.sendRequest('session.spawn', {
    cwd: join(ctx.dir, 'clone'),
    agent: 'claude',
    target: 'local',
    workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
  });

  await waitFor(() => {
    expect(existsSync(ctx.starts)).toBeTrue();
  });

  expect(JSON.parse(readFileSync(ctx.claudeConfig, 'utf8'))).toStrictEqual({
    projects: { [join(ctx.dir, 'clone')]: { hasTrustDialogAccepted: true } },
  });
});

test('it refuses local trust for an existing folder', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: ctx.adapters,
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: new LocalPTYProvider(),
        },
      ],
      defaultTarget: 'local',
    }),
  });

  mkdirSync(join(ctx.dir, 'existing'));
  writeFileSync(ctx.claudeConfig, '{"projects":{}}');

  expect(
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.dir, 'existing'),
      agent: 'claude',
      target: 'local',
    }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it leaves the user config and starts nothing when it refuses local trust for an existing folder', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: ctx.adapters,
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: new LocalPTYProvider(),
        },
      ],
      defaultTarget: 'local',
    }),
  });

  mkdirSync(join(ctx.dir, 'existing'));
  writeFileSync(ctx.claudeConfig, '{"projects":{}}');

  await Promise.allSettled([
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.dir, 'existing'),
      agent: 'claude',
      target: 'local',
    }),
  ]);

  expect({
    config: readFileSync(ctx.claudeConfig, 'utf8'),
    started: existsSync(ctx.starts),
  }).toStrictEqual({ config: '{"projects":{}}', started: false });
});

test('it refuses a local launch whose harness fails to start after the trust write', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: ctx.adapters,
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: buildStubPTYProvider({
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
      cwd: join(ctx.dir, 'clone'),
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
  await using ctx = await setupTest();

  const atSpawn: unknown[] = [];

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: ctx.adapters,
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: buildStubPTYProvider({
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

  const original = JSON.stringify(
    { projects: { '/home/me': { hasTrustDialogAccepted: true } } },
    null,
    2,
  );

  writeFileSync(ctx.claudeConfig, original);

  await Promise.allSettled([
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.dir, 'clone'),
      agent: 'claude',
      target: 'local',
      workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
    }),
  ]);

  expect({
    atSpawn,
    config: readFileSync(ctx.claudeConfig, 'utf8'),
    cloned: existsSync(join(ctx.dir, 'clone')),
  }).toStrictEqual({
    atSpawn: [
      {
        projects: {
          '/home/me': { hasTrustDialogAccepted: true },
          [join(ctx.dir, 'clone')]: { hasTrustDialogAccepted: true },
        },
      },
    ],
    config: original,
    cloned: false,
  });
});

test('it refuses a local launch whose trust write fails', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: ctx.adapters,
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: new LocalPTYProvider(),
        },
      ],
      defaultTarget: 'local',
    }),
  });

  writeFileSync(ctx.claudeConfig, '{"projects":');

  expect(
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.dir, 'clone'),
      agent: 'claude',
      target: 'local',
      workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
    }),
  ).rejects.toMatchObject({ code: 'internal', message: 'JSON Parse error: Unexpected EOF' });
});

test('it removes the clone, keeps the user config, and starts nothing when the trust write fails', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: ctx.adapters,
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: new LocalPTYProvider(),
        },
      ],
      defaultTarget: 'local',
    }),
  });

  writeFileSync(ctx.claudeConfig, '{"projects":');

  await Promise.allSettled([
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.dir, 'clone'),
      agent: 'claude',
      target: 'local',
      workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
    }),
  ]);

  expect({
    config: readFileSync(ctx.claudeConfig, 'utf8'),
    cloned: existsSync(join(ctx.dir, 'clone')),
    started: existsSync(ctx.starts),
  }).toStrictEqual({ config: '{"projects":', cloned: false, started: false });
});

test('it refuses local trust for a gateway', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: ctx.adapters,
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: new LocalPTYProvider(),
        },
      ],
      defaultTarget: 'local',
    }),
  });

  writeFileSync(ctx.claudeConfig, '{"projects":{}}');

  expect(
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.dir, 'clone'),
      agent: 'plain',
      target: 'local',
      workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
    }),
  ).rejects.toMatchObject({
    code: 'unsupported',
    message:
      'trustClonedWorkspace requires stock Claude on the local target, or stock Claude, a Claude gateway, or Codex signed in through the broker on an imp target',
  });
});

test('it refuses local trust for a gateway before cloning or touching the user config', async () => {
  await using ctx = await setupTest();

  await using daemon = await startTestDaemon({
    options: () => ({
      adapters: ctx.adapters,
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: new LocalPTYProvider(),
        },
      ],
      defaultTarget: 'local',
    }),
  });

  writeFileSync(ctx.claudeConfig, '{"projects":{}}');

  await Promise.allSettled([
    daemon.client.sendRequest('session.spawn', {
      trustClonedWorkspace: true,
      cwd: join(ctx.dir, 'clone'),
      agent: 'plain',
      target: 'local',
      workspace: { kind: 'git', url: `file://${ctx.upstream}`, ref: 'main' },
    }),
  ]);

  expect({
    config: readFileSync(ctx.claudeConfig, 'utf8'),
    cloned: existsSync(join(ctx.dir, 'clone')),
    started: existsSync(ctx.starts),
  }).toStrictEqual({ config: '{"projects":{}}', cloned: false, started: false });
});
