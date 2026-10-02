import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { startLegacyDaemon } from '../../test/start-legacy-daemon';
import { DaemonError } from '../protocol/daemon-error';
import { DAEMON_FEATURES } from '../protocol/daemon-features';
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
  const legacy = startLegacyDaemon(socketPath, 'pre-spawn-options');

  const caller = new ReconnectingCaller(socketPath, 'atc/test-build');

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
