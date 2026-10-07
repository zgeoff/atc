import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { DaemonClient } from '../client/daemon-client';
import { DaemonError } from '../protocol/daemon-error';
import { DAEMON_FEATURES } from '../protocol/daemon-features';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubFleetCaller } from '../test-utils/build-stub-fleet-caller';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startLegacyDaemon } from '../test-utils/start-legacy-daemon';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { ReconnectingCaller } from './reconnecting-caller';
import { runTool } from './run-tool';

// A real daemon whose sessions run `sleep`, and `atc mcp`'s caller in front
// of it, which connects on its first request.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const daemon = await startTestDaemon({
    prefix: 'atc-run-tool-',
    options: () => ({ adapter: buildMockAgentAdapter() }),
  });

  stack.use(daemon);

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  stack.defer(() => caller.stop());

  const owned = stack.move();

  return {
    caller,
    dir: daemon.dir,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it sends a message from a fixed sender whatever sender the call gives', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1' }) });

  await runTool(
    caller,
    'atc_session_message',
    { session: 's1', text: 'hello', from: 'owner' },
    { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
  );

  expect(caller.requests).toStrictEqual([
    { m: 'session.message', p: { session: 's1', text: 'hello', from: 'dots' }, required: [] },
  ]);
});

test('it sends a message from the sender the call gives over a default sender', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1' }) });

  await runTool(
    caller,
    'atc_session_message',
    { session: 's1', text: 'hello', from: 'reviewer' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(caller.requests).toStrictEqual([
    { m: 'session.message', p: { session: 's1', text: 'hello', from: 'reviewer' }, required: [] },
  ]);
});

test('it sends a message from a default sender when the call gives none', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1' }) });

  await runTool(
    caller,
    'atc_session_message',
    { session: 's1', text: 'hello' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(caller.requests).toStrictEqual([
    { m: 'session.message', p: { session: 's1', text: 'hello', from: 'mcp' }, required: [] },
  ]);
});

test('it forwards a message wait to the daemon', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1', status: 'delivered' }) });

  await runTool(
    caller,
    'atc_message_get',
    { message: 'm1', waitMs: 20_000 },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(caller.requests).toStrictEqual([
    { m: 'message.get', p: { message: 'm1', waitMs: 20_000 }, required: ['message.wait'] },
  ]);
});

test('it forwards an events session filter to the daemon', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ events: [], cursor: 'c', more: false }) });

  await runTool(
    caller,
    'atc_events_read',
    { session: 's1', waitMs: 1000 },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(caller.requests).toStrictEqual([
    { m: 'events.read', p: { waitMs: 1000, session: 's1' }, required: ['events.session'] },
  ]);
});

test('it reads the text of each report of an events page when the call asks for report text', async () => {
  const answers: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    'events.read': {
      events: [
        {
          cursor: 'c1',
          at: 1,
          session: 's1',
          name: null,
          kind: 'report',
          detail: 'hi',
          label: 'l',
        },
      ],
      cursor: 'c1',
      more: false,
    },
    'report.get': { text: 'hi there', complete: true },
  };

  const caller = buildStubFleetCaller({ answer: (request) => answers[request.m] ?? {} });

  const read = await runTool(
    caller,
    'atc_events_read',
    { cursor: 'c0', reportText: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(caller.requests).toStrictEqual([
    { m: 'events.read', p: { cursor: 'c0' }, required: [] },
    { m: 'report.get', p: { report: 'c1' }, required: ['report.get'] },
  ]);

  expect(read.structured).toStrictEqual({
    events: [
      {
        cursor: 'c1',
        at: 1,
        session: 's1',
        name: null,
        kind: 'report',
        detail: 'hi',
        label: 'l',
        text: 'hi there',
        complete: true,
      },
    ],
    cursor: 'c1',
    more: false,
  });
});

test('it sends a message under the key the call gives and needs a daemon that takes keys', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1' }) });

  await runTool(
    caller,
    'atc_session_message',
    { session: 's1', text: 'hello', idempotencyKey: 'k-1' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.message',
      p: { session: 's1', text: 'hello', from: 'mcp', idempotencyKey: 'k-1' },
      required: ['message.idempotency'],
    },
  ]);
});

test('it spawns top-level under a key of its own when the calling session is gone', async () => {
  await using ctx = await setupTest();

  const relay = buildStubFleetCaller({
    answer: (request) =>
      ctx.caller.sendRequest(request.m, request.p, request.required, request.principal),
  });

  await runTool(
    relay,
    'atc_session_spawn',
    { cwd: ctx.dir, idempotencyKey: 'k-1' },
    { callerSessionID: 'gone', sender: { kind: 'default', name: 'mcp' } },
  );

  expect(relay.requests).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: ctx.dir, idempotencyKey: 'k-1', cols: 100, rows: 30, parent: 'gone' },
      required: ['spawn.idempotency'],
    },
    {
      m: 'session.spawn',
      p: {
        cwd: ctx.dir,
        idempotencyKey:
          'top-level:7c35c5a1785d20704e44d5de4beb81c1fce91b6fe48ed7c3159af6f7f832078b',
        cols: 100,
        rows: 30,
      },
      required: ['spawn.idempotency'],
    },
  ]);
});

test('it spawns nothing top-level when the gone session belongs to a spawn its key already ran', () => {
  // A daemon refuses a retried keyed spawn this way once the session the key
  // created is no longer listed, which takes a restart mid-spawn to reach.
  const caller = buildStubFleetCaller({
    answer: () => {
      throw new DaemonError('no_such_session', 'not listed', { effectRef: 's-1' });
    },
  });

  const call = runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp', idempotencyKey: 'k-1' },
    { callerSessionID: 'parent', sender: { kind: 'default', name: 'mcp' } },
  );

  expect(call).rejects.toMatchObject({ code: 'no_such_session', data: { effectRef: 's-1' } });

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: '/tmp', idempotencyKey: 'k-1', cols: 100, rows: 30, parent: 'parent' },
      required: ['spawn.idempotency'],
    },
  ]);
});

test('it derives a top-level fallback key within the daemon cap from the longest key a call may pass', async () => {
  await using ctx = await setupTest();

  const relay = buildStubFleetCaller({
    answer: (request) =>
      ctx.caller.sendRequest(request.m, request.p, request.required, request.principal),
  });

  await runTool(
    relay,
    'atc_session_spawn',
    { cwd: ctx.dir, idempotencyKey: 'k'.repeat(180) },
    { callerSessionID: 'gone', sender: { kind: 'default', name: 'mcp' } },
  );

  expect(relay.requests.map((request) => request.p?.['idempotencyKey'])).toStrictEqual([
    'k'.repeat(180),
    expect.stringMatching(/^top-level:[0-9a-f]{64}$/),
  ]);
});

test('it derives the same top-level fallback key when the call is retried', async () => {
  await using ctx = await setupTest();

  const relay = buildStubFleetCaller({
    answer: (request) =>
      ctx.caller.sendRequest(request.m, request.p, request.required, request.principal),
  });

  await runTool(
    relay,
    'atc_session_spawn',
    { cwd: ctx.dir, idempotencyKey: 'k'.repeat(180) },
    { callerSessionID: 'gone', sender: { kind: 'default', name: 'mcp' } },
  );

  await runTool(
    relay,
    'atc_session_spawn',
    { cwd: ctx.dir, idempotencyKey: 'k'.repeat(180) },
    { callerSessionID: 'gone', sender: { kind: 'default', name: 'mcp' } },
  );

  const keys = relay.requests.map((request) => request.p?.['idempotencyKey']);

  expect(keys).toStrictEqual(['k'.repeat(180), keys[1], 'k'.repeat(180), keys[1]]);
});

test('it refuses a spawn key longer than 180 characters as bad_args and sends nothing', () => {
  const caller = buildStubFleetCaller({ answer: () => ({ session: { id: 's-1' } }) });

  const call = runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp', idempotencyKey: 'k'.repeat(181) },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(call).rejects.toMatchObject({ code: 'bad_args' });
  expect(caller.requests).toStrictEqual([]);
});

test('it refuses a message key longer than 180 characters as bad_args and sends nothing', () => {
  const caller = buildStubFleetCaller({ answer: () => ({ message: 'm1' }) });

  const call = runTool(
    caller,
    'atc_session_message',
    { session: 's1', text: 'hello', idempotencyKey: 'k'.repeat(181) },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(call).rejects.toMatchObject({ code: 'bad_args' });
  expect(caller.requests).toStrictEqual([]);
});

test('it spawns on the target the call gives and needs a daemon that takes targets', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ session: { id: 's-1' } }) });

  await runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp', target: 'box' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: '/tmp', target: 'box', cols: 100, rows: 30 },
      required: ['spawn.target'],
    },
  ]);
});

test('it refuses a spawn on a target unsent when the daemon predates targets', () => {
  using tmp = setupTempDir('atc-run-tool-');

  using legacy = startLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: ['agents.list', 'events.more', 'events.session', 'message.turn', 'message.wait'],
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const spawn = runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp', target: 'box' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(spawn).rejects.toThrow(/^daemon_outdated: .*atc_session_spawn's target/);
  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it spawns with the workspace the call gives and needs a daemon that takes workspaces', async () => {
  const workspace = { kind: 'git', url: 'https://example.com/r.git', ref: 'main' };
  const caller = buildStubFleetCaller({ answer: () => ({ session: { id: 's-1' } }) });

  await runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: '/tmp/ws', workspace, cols: 100, rows: 30 },
      required: ['spawn.workspace'],
    },
  ]);
});

test('it spawns a git workspace without a cwd and returns the directory the daemon picked under the home', async () => {
  await using daemon = await startTestDaemon({
    prefix: 'atc-run-tool-',
    options: (paths) => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['file'],
      homeDir: join(paths.dir, 'home'),
    }),
  });

  const caller = new ReconnectingCaller(daemon.socketPath, daemon.build, (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const home = join(daemon.dir, 'home');
  const upstream = join(daemon.dir, 'upstream.git');
  const work = join(daemon.dir, 'work');

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();

  await $`git -c user.name=atc -c user.email=atc@example.com -c commit.gpgsign=false commit --quiet --allow-empty -m initial`
    .env(env)
    .cwd(work)
    .quiet();

  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  const result = await runTool(
    caller,
    'atc_session_spawn',
    { workspace: { kind: 'git', url: upstream, ref: 'main' } },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(result.structured).toMatchObject({
    cwd: join(home, '.local/share/atc/workspaces/upstream-main'),
    workspace: { repoURL: upstream, ref: 'main' },
  });

  expect(existsSync(join(home, '.local/share/atc/workspaces/upstream-main', '.git'))).toBeTrue();
});

test('it refuses a git workspace without a cwd unsent when the daemon predates picking its directory', () => {
  using tmp = setupTempDir('atc-run-tool-');

  using legacy = startLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: DAEMON_FEATURES.filter((feature) => feature !== 'spawn.workspace.autoDir'),
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const spawn = runTool(
    caller,
    'atc_session_spawn',
    { workspace: { kind: 'git', url: 'https://example.com/r.git', ref: 'main' } },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(spawn).rejects.toThrow(
    /^daemon_outdated: .*atc_session_spawn's git workspace without a cwd/,
  );

  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it returns the warnings a workspace spawn left with the session', async () => {
  const caller = buildStubFleetCaller({
    answer: () => ({ session: { id: 's-1' }, warnings: ['changes stay behind'] }),
  });

  const result = await runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace: { kind: 'path', path: '/src/repo', allowDirty: 'warn' } },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(result.structured).toStrictEqual({ id: 's-1', warnings: ['changes stay behind'] });
});

test('it refuses a spawn with a workspace unsent when the daemon predates workspaces', () => {
  using tmp = setupTempDir('atc-run-tool-');

  using legacy = startLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: ['agents.list', 'events.more', 'events.session', 'message.turn', 'message.wait'],
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const spawn = runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace: { kind: 'path', path: '/src/repo' } },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(spawn).rejects.toThrow(/^daemon_outdated: .*atc_session_spawn's workspace/);
  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it submits a session input line and needs a daemon that submits lines', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({}) });

  await runTool(
    caller,
    'atc_session_input',
    { session: 's1', text: 'hello' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(caller.requests).toStrictEqual([
    { m: 'session.submit', p: { session: 's1', text: 'hello' }, required: ['session.submit'] },
  ]);
});

test('it refuses a session input line unsent when the daemon predates line submission', () => {
  using tmp = setupTempDir('atc-run-tool-');

  using legacy = startLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: DAEMON_FEATURES.filter((feature) => feature !== 'session.submit'),
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const input = runTool(
    caller,
    'atc_session_input',
    { session: 's1', text: 'hello' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(input).rejects.toThrow(/^daemon_outdated: .*atc_session_input/);
  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it reads a report through a daemon that serves report reads', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({}) });

  await runTool(
    caller,
    'atc_report_get',
    { report: 'r1' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(caller.requests).toStrictEqual([
    { m: 'report.get', p: { report: 'r1' }, required: ['report.get'] },
  ]);
});

test('it refuses a report read unsent when the daemon predates report reads', () => {
  using tmp = setupTempDir('atc-run-tool-');

  using legacy = startLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: DAEMON_FEATURES.filter((feature) => feature !== 'report.get'),
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const read = runTool(
    caller,
    'atc_report_get',
    { report: 'r1' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(read).rejects.toThrow(/^daemon_outdated: .*atc_report_get/);
  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it forwards an explicit clone trust decision and requires daemon support', async () => {
  const workspace = { kind: 'git', url: 'https://example.com/r.git', ref: 'main' };
  const caller = buildStubFleetCaller({ answer: () => ({ session: { id: 's-1' } }) });

  await runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace, trustClonedWorkspace: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: '/tmp/ws', workspace, trustClonedWorkspace: true, cols: 100, rows: 30 },
      required: ['spawn.workspace', 'spawn.workspace.trust'],
    },
  ]);
});

test('it refuses an explicit trust decision unsent when the daemon predates clone trust', () => {
  using tmp = setupTempDir('atc-run-tool-');

  using legacy = startLegacyDaemon(join(tmp.dir, 'daemon.sock'), {
    features: [
      'agents.list',
      'events.more',
      'events.session',
      'message.turn',
      'message.wait',
      'spawn.workspace',
    ],
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const spawn = runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace: { kind: 'path', path: '/src/repo' }, trustClonedWorkspace: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(spawn).rejects.toThrow(/^daemon_outdated: .*atc_session_spawn's trustClonedWorkspace/);
  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});
