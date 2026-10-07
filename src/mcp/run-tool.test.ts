import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { DaemonClient } from '../client/daemon-client';
import { startDaemon } from '../daemon/daemon';
import { DaemonError } from '../protocol/daemon-error';
import { DAEMON_FEATURES } from '../protocol/daemon-features';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startLegacyDaemon } from '../test-utils/start-legacy-daemon';
import { updateEnv } from '../test-utils/update-env';
import { ReconnectingCaller } from './reconnecting-caller';
import { runTool } from './run-tool';

test('it sends a message from a fixed sender whatever sender the call gives', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.resolve({ message: 'm1' });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_message',
    { session: 's1', text: 'hello', from: 'owner' },
    { callerSessionID: null, sender: { kind: 'fixed', name: 'dots' } },
  );

  expect(sent).toStrictEqual([
    { m: 'session.message', p: { session: 's1', text: 'hello', from: 'dots' } },
  ]);
});

test('it sends a message from the sender the call gives over a default sender', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.resolve({ message: 'm1' });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_message',
    { session: 's1', text: 'hello', from: 'reviewer' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([
    { m: 'session.message', p: { session: 's1', text: 'hello', from: 'reviewer' } },
  ]);
});

test('it sends a message from a default sender when the call gives none', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.resolve({ message: 'm1' });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_message',
    { session: 's1', text: 'hello' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([
    { m: 'session.message', p: { session: 's1', text: 'hello', from: 'mcp' } },
  ]);
});

test('it forwards a message wait to the daemon', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.resolve({ message: 'm1', status: 'delivered' });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_message_get',
    { message: 'm1', waitMs: 20_000 },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([{ m: 'message.get', p: { message: 'm1', waitMs: 20_000 } }]);
});

test('it forwards an events session filter to the daemon', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.resolve({ events: [], cursor: 'c', more: false });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_events_read',
    { session: 's1', waitMs: 1000 },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([{ m: 'events.read', p: { waitMs: 1000, session: 's1' } }]);
});

test('it reads the text of each report of an events page when the call asks for report text', async () => {
  const sent: unknown[] = [];

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

  const read = await runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.resolve(answers[m] ?? {});
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_events_read',
    { cursor: 'c0', reportText: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([
    { m: 'events.read', p: { cursor: 'c0' } },
    { m: 'report.get', p: { report: 'c1' } },
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
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p, required) => {
        sent.push({ m, p, required });

        return Promise.resolve({ message: 'm1' });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_message',
    { session: 's1', text: 'hello', idempotencyKey: 'k-1' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([
    {
      m: 'session.message',
      p: { session: 's1', text: 'hello', from: 'mcp', idempotencyKey: 'k-1' },
      required: ['message.idempotency'],
    },
  ]);
});

test('it spawns top-level under a key of its own when the calling session is gone', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p, required) => {
        sent.push({ m, p, required });

        if (p?.['parent'] !== undefined) {
          return Promise.reject(new DaemonError('no_such_session', 'session gone'));
        }

        return Promise.resolve({ session: { id: 's-2' } });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_spawn',
    { cwd: '/tmp', idempotencyKey: 'k-1' },
    { callerSessionID: 'gone', sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: '/tmp', idempotencyKey: 'k-1', cols: 100, rows: 30, parent: 'gone' },
      required: ['spawn.idempotency'],
    },
    {
      m: 'session.spawn',
      p: {
        cwd: '/tmp',
        idempotencyKey:
          'top-level:7c35c5a1785d20704e44d5de4beb81c1fce91b6fe48ed7c3159af6f7f832078b',
        cols: 100,
        rows: 30,
      },
      required: ['spawn.idempotency'],
    },
  ]);
});

test('it spawns nothing top-level when the gone session belongs to a spawn its key already ran', async () => {
  const sent: unknown[] = [];

  const call = runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.reject(
          new DaemonError('no_such_session', 'not listed', { effectRef: 's-1' }),
        );
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_spawn',
    { cwd: '/tmp', idempotencyKey: 'k-1' },
    { callerSessionID: 'parent', sender: { kind: 'default', name: 'mcp' } },
  );

  expect(call).rejects.toMatchObject({ code: 'no_such_session', data: { effectRef: 's-1' } });

  await call.catch(() => null);

  expect(sent).toHaveLength(1);
});

test('it derives a top-level fallback key within the daemon cap from the longest key a call may pass', async () => {
  const keys: unknown[] = [];

  const runSpawn = () =>
    runTool(
      {
        sendRequest: (_m, p) => {
          keys.push(p?.['idempotencyKey']);

          if (p?.['parent'] !== undefined) {
            return Promise.reject(new DaemonError('no_such_session', 'session gone'));
          }

          return Promise.resolve({ session: { id: 's-2' } });
        },
        readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
      },
      'atc_session_spawn',
      { cwd: '/tmp', idempotencyKey: 'k'.repeat(180) },
      { callerSessionID: 'gone', sender: { kind: 'default', name: 'mcp' } },
    );

  await runSpawn();
  await runSpawn();

  expect(keys).toStrictEqual([
    'k'.repeat(180),
    expect.stringMatching(/^top-level:[0-9a-f]{64}$/),
    'k'.repeat(180),
    keys[1],
  ]);
});

test('it refuses a spawn key longer than 180 characters as bad_args and sends nothing', async () => {
  const sent: unknown[] = [];

  const call = runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.resolve({ session: { id: 's-1' } });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_spawn',
    { cwd: '/tmp', idempotencyKey: 'k'.repeat(181) },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(call).rejects.toMatchObject({ code: 'bad_args' });

  await call.catch(() => null);

  expect(sent).toStrictEqual([]);
});

test('it refuses a message key longer than 180 characters as bad_args and sends nothing', async () => {
  const sent: unknown[] = [];

  const call = runTool(
    {
      sendRequest: (m, p) => {
        sent.push({ m, p });

        return Promise.resolve({ message: 'm1' });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_message',
    { session: 's1', text: 'hello', idempotencyKey: 'k'.repeat(181) },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(call).rejects.toMatchObject({ code: 'bad_args' });

  await call.catch(() => null);

  expect(sent).toStrictEqual([]);
});

test('it spawns on the target the call gives and needs a daemon that takes targets', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p, required) => {
        sent.push({ m, p, required });

        return Promise.resolve({ session: { id: 's-1' } });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_spawn',
    { cwd: '/tmp', target: 'box' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: '/tmp', target: 'box', cols: 100, rows: 30 },
      required: ['spawn.target'],
    },
  ]);
});

test('it refuses a spawn on a target unsent when the daemon predates targets', async () => {
  using tmp = setupTempDir('atc-run-tool-');

  const socketPath = join(tmp.dir, 'daemon.sock');

  const legacy = startLegacyDaemon(socketPath, {
    features: ['agents.list', 'events.more', 'events.session', 'message.turn', 'message.wait'],
  });

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();

    legacy.stop();
  });

  const spawn = runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp', target: 'box' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(spawn).rejects.toThrow(/^daemon_outdated: .*atc_session_spawn's target/);

  await spawn.catch(() => null);

  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it spawns with the workspace the call gives and needs a daemon that takes workspaces', async () => {
  const sent: unknown[] = [];
  const workspace = { kind: 'git', url: 'https://example.com/r.git', ref: 'main' };

  await runTool(
    {
      sendRequest: (m, p, required) => {
        sent.push({ m, p, required });

        return Promise.resolve({ session: { id: 's-1' } });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: '/tmp/ws', workspace, cols: 100, rows: 30 },
      required: ['spawn.workspace'],
    },
  ]);
});

test('it spawns a git workspace without a cwd and returns the directory the daemon picked under the home', async () => {
  using tmp = setupTempDir('atc-run-tool-');

  const home = join(tmp.dir, 'home');
  const upstream = join(tmp.dir, 'upstream.git');
  const work = join(tmp.dir, 'work');

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };

  const socketPath = join(tmp.dir, 'daemon.sock');

  updateEnv('HOME', home);

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();

  await $`git -c user.name=atc -c user.email=atc@example.com -c commit.gpgsign=false commit --quiet --allow-empty -m initial`
    .env(env)
    .cwd(work)
    .quiet();

  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  const daemon = await startDaemon({
    gitTransports: ['file'],
    socketPath,
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
    adapter: {
      id: 'claude',
      headlessRunner: null,
      screenDetector: null,
      takesMessages: false,
      planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
      normalizeHook: () => ({ kind: 'heartbeat' }),
      loadName: () => Promise.resolve(null),
      canResume: () => true,
      buildResumeCommand: () => null,
    },
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
  });

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();
    await daemon.stop();
  });

  const result = await runTool(
    caller,
    'atc_session_spawn',
    { workspace: { kind: 'git', url: upstream, ref: 'main' } },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  const dest = join(home, '.local/share/atc/workspaces/upstream-main');

  expect(result.structured).toMatchObject({
    cwd: dest,
    workspace: { repoURL: upstream, ref: 'main' },
  });

  expect(existsSync(join(dest, '.git'))).toBeTrue();
});

test('it refuses a git workspace without a cwd unsent when the daemon predates picking its directory', async () => {
  using tmp = setupTempDir('atc-run-tool-');

  const socketPath = join(tmp.dir, 'daemon.sock');

  const legacy = startLegacyDaemon(socketPath, {
    features: DAEMON_FEATURES.filter((feature) => feature !== 'spawn.workspace.autoDir'),
  });

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();

    legacy.stop();
  });

  const spawn = runTool(
    caller,
    'atc_session_spawn',
    { workspace: { kind: 'git', url: 'https://example.com/r.git', ref: 'main' } },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(spawn).rejects.toThrow(
    /^daemon_outdated: .*atc_session_spawn's git workspace without a cwd/,
  );

  await spawn.catch(() => null);

  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it returns the warnings a workspace spawn left with the session', async () => {
  const result = await runTool(
    {
      sendRequest: () =>
        Promise.resolve({ session: { id: 's-1' }, warnings: ['changes stay behind'] }),
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace: { kind: 'path', path: '/src/repo', allowDirty: 'warn' } },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(result.structured).toStrictEqual({ id: 's-1', warnings: ['changes stay behind'] });
});

test('it refuses a spawn with a workspace unsent when the daemon predates workspaces', async () => {
  using tmp = setupTempDir('atc-run-tool-');

  const socketPath = join(tmp.dir, 'daemon.sock');

  const legacy = startLegacyDaemon(socketPath, {
    features: ['agents.list', 'events.more', 'events.session', 'message.turn', 'message.wait'],
  });

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();

    legacy.stop();
  });

  const spawn = runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace: { kind: 'path', path: '/src/repo' } },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(spawn).rejects.toThrow(/^daemon_outdated: .*atc_session_spawn's workspace/);

  await spawn.catch(() => null);

  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it submits a session input line and needs a daemon that submits lines', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p, required) => {
        sent.push({ m, p, required });

        return Promise.resolve({});
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_input',
    { session: 's1', text: 'hello' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([
    { m: 'session.submit', p: { session: 's1', text: 'hello' }, required: ['session.submit'] },
  ]);
});

test('it refuses a session input line unsent when the daemon predates line submission', async () => {
  using tmp = setupTempDir('atc-run-tool-');

  const socketPath = join(tmp.dir, 'daemon.sock');

  const legacy = startLegacyDaemon(socketPath, {
    features: DAEMON_FEATURES.filter((feature) => feature !== 'session.submit'),
  });

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();

    legacy.stop();
  });

  const input = runTool(
    caller,
    'atc_session_input',
    { session: 's1', text: 'hello' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(input).rejects.toThrow(/^daemon_outdated: .*atc_session_input/);

  await input.catch(() => null);

  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it reads a report through a daemon that serves report reads', async () => {
  const sent: unknown[] = [];

  await runTool(
    {
      sendRequest: (m, p, required) => {
        sent.push({ m, p, required });

        return Promise.resolve({});
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_report_get',
    { report: 'r1' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([{ m: 'report.get', p: { report: 'r1' }, required: ['report.get'] }]);
});

test('it refuses a report read unsent when the daemon predates report reads', async () => {
  using tmp = setupTempDir('atc-run-tool-');

  const socketPath = join(tmp.dir, 'daemon.sock');

  const legacy = startLegacyDaemon(socketPath, {
    features: DAEMON_FEATURES.filter((feature) => feature !== 'report.get'),
  });

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();

    legacy.stop();
  });

  const read = runTool(
    caller,
    'atc_report_get',
    { report: 'r1' },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(read).rejects.toThrow(/^daemon_outdated: .*atc_report_get/);

  await read.catch(() => null);

  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it forwards an explicit clone trust decision and requires daemon support', async () => {
  const sent: unknown[] = [];
  const workspace = { kind: 'git', url: 'https://example.com/r.git', ref: 'main' };

  await runTool(
    {
      sendRequest: (m, p, required) => {
        sent.push({ m, p, required });

        return Promise.resolve({ session: { id: 's-1' } });
      },
      readFeatures: () => Promise.resolve(new Set(DAEMON_FEATURES)),
    },
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace, trustClonedWorkspace: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(sent).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: '/tmp/ws', workspace, trustClonedWorkspace: true, cols: 100, rows: 30 },
      required: ['spawn.workspace', 'spawn.workspace.trust'],
    },
  ]);
});

test('it refuses an explicit trust decision unsent when the daemon predates clone trust', async () => {
  using tmp = setupTempDir('atc-run-tool-');

  const socketPath = join(tmp.dir, 'daemon.sock');

  const legacy = startLegacyDaemon(socketPath, {
    features: [
      'agents.list',
      'events.more',
      'events.session',
      'message.turn',
      'message.wait',
      'spawn.workspace',
    ],
  });

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(async () => {
    await caller.stop();

    legacy.stop();
  });

  const spawn = runTool(
    caller,
    'atc_session_spawn',
    { cwd: '/tmp/ws', workspace: { kind: 'path', path: '/src/repo' }, trustClonedWorkspace: true },
    { callerSessionID: null, sender: { kind: 'default', name: 'mcp' } },
  );

  expect(spawn).rejects.toThrow(/^daemon_outdated: .*atc_session_spawn's trustClonedWorkspace/);

  await spawn.catch(() => null);

  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});
