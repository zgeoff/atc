import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from './connect';
import { startStubDaemon } from './test-utils/start-stub-daemon';
import { waitUntil } from './test-utils/wait-until';

function setupTest() {
  const home = mkdtempSync(join(tmpdir(), 'atcx-connect-'));
  const runtime = join(home, 'run');
  const state = join(home, '.local', 'state', 'atc');

  mkdirSync(runtime, { recursive: true });
  mkdirSync(state, { recursive: true });

  onTestFinished(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const original = { HOME: process.env['HOME'], XDG_RUNTIME_DIR: process.env['XDG_RUNTIME_DIR'] };

  process.env['HOME'] = home;
  process.env['XDG_RUNTIME_DIR'] = runtime;

  onTestFinished(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  return {
    computedSocket: join(runtime, 'atc-daemon.sock'),
    writeRecord: (socketPath: string) => {
      writeFileSync(join(state, 'daemon.json'), JSON.stringify({ pid: 1, socketPath }));
    },
  };
}

test('it returns every daemon procedure with the hello and the features the daemon lists', async () => {
  const daemon = await startStubDaemon({
    features: ['events.read.from-start'],
    answer: () => ({ ok: { sessions: [] } }),
  });

  onTestFinished(daemon.stop);

  const atc = await connect({ socketPath: daemon.path, client: 'stu-watcher' });

  onTestFinished(atc.close);

  const listed = await atc.session.list({});

  expect(listed).toStrictEqual({ sessions: [] });
  expect(atc.hello.daemonID).toBe('d_stub');
  expect(atc.has('events.read.from-start')).toBe(true);
  expect(daemon.requests[0]?.params).toMatchObject({ client: 'stu-watcher' });
});

test('it reads each event through events() and settles closed after close', async () => {
  const daemon = await startStubDaemon();

  onTestFinished(daemon.stop);

  const atc = await connect({ socketPath: daemon.path });

  const events = atc.events()[Symbol.asyncIterator]();

  await waitUntil(() => {
    expect(daemon.subscriptions).toBe(1);
  });

  daemon.emit({ ev: 'SessionRemoved', sessionID: 's_1' });

  const first = await events.next();

  await atc[Symbol.asyncDispose]();

  await atc.closed;

  const last = await events.next();

  expect(first).toStrictEqual({ done: false, value: { ev: 'SessionRemoved', sessionID: 's_1' } });
  expect(last).toStrictEqual({ done: true, value: undefined });
});

test('it throws no_daemon with each path it tried when no daemon answers', () => {
  const ctx = setupTest();

  ctx.writeRecord('/elsewhere/atc-daemon.sock');

  expect(connect()).rejects.toMatchObject({
    code: 'no_daemon',
    data: { tried: [ctx.computedSocket, '/elsewhere/atc-daemon.sock'] },
  });
});

test('it moves on to the path the daemon record holds when the computed path has no daemon', async () => {
  const ctx = setupTest();

  const daemon = await startStubDaemon();

  onTestFinished(daemon.stop);

  ctx.writeRecord(daemon.path);

  const atc = await connect();

  onTestFinished(atc.close);

  expect(atc.hello.daemon).toBe('atc/stub');
});

test.each([
  ['a token', { token: 'tok' }],
  ['a principal', { principal: 'alice' }],
])('it throws bad_args before it connects when an address has only %s', (_name, credentials) => {
  expect(
    connect({ address: { hostname: '127.0.0.1', port: 1 }, ...credentials }),
  ).rejects.toMatchObject({ code: 'bad_args' });
});

test('it throws the daemon refusal of the hello and leaves no open socket', async () => {
  const daemon = await startStubDaemon({
    hello: () => ({ err: { code: 'unauthorized', message: 'no', data: { why: 'token' } } }),
  });

  onTestFinished(daemon.stop);

  const connecting = connect({ socketPath: daemon.path });

  expect(connecting).rejects.toMatchObject({ code: 'unauthorized', data: { why: 'token' } });

  await Promise.allSettled([connecting]);

  await waitUntil(() => {
    expect(daemon.openConnections).toBe(0);
  });
});
