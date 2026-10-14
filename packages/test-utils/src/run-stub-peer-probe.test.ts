import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { runCommand } from '@atc/test-utils/run-command';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { startStubLegacyDaemon } from '@atc/test-utils/start-stub-legacy-daemon';

// A socket path and an output path in a fresh temp directory, and the probe
// script's path.
function setupTest() {
  const tmp = setupTempDir('atc-peer-probe-');

  return {
    socketPath: join(tmp.dir, 'daemon.sock'),
    outPath: join(tmp.dir, 'probe.json'),
    probe: join(import.meta.dir, 'run-stub-peer-probe.ts'),
  };
}

test('it adds an empty scope to the session after a handshake without a session', async () => {
  const ctx = setupTest();

  const daemon = startStubLegacyDaemon(ctx.socketPath, {
    replies: { 'session.scope.add': { record: {} } },
  });

  await runCommand([process.execPath, ctx.probe, 'scope-add', ctx.socketPath, 's-7', ctx.outPath]);

  expect(JSON.parse(readFileSync(ctx.outPath, 'utf8'))).toStrictEqual({ ok: true });

  expect(daemon.requests).toStrictEqual([
    { m: 'daemon.hello', p: { client: 'atc/peer-probe', auth: { scheme: 'none' } } },
    { m: 'session.scope.add', p: { session: 's-7', scope: {} } },
  ]);
});

test('it writes the code of a refused request', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(ctx.socketPath);

  await runCommand([process.execPath, ctx.probe, 'scope-add', ctx.socketPath, 's-7', ctx.outPath]);

  expect(JSON.parse(readFileSync(ctx.outPath, 'utf8'))).toStrictEqual({ code: 'unknown_method' });
});

test('it writes the sender the daemon recorded for the message it sent', async () => {
  const ctx = setupTest();

  const daemon = startStubLegacyDaemon(ctx.socketPath, {
    replies: {
      'session.message': { message: 'm-3', status: 'queued' },
      'message.get': {
        from: 'harbor-refactor',
        sender: { kind: 'session', session: 's-7', name: 'harbor-refactor' },
      },
    },
  });

  await runCommand([process.execPath, ctx.probe, 'message', ctx.socketPath, 's-7', ctx.outPath]);

  expect(JSON.parse(readFileSync(ctx.outPath, 'utf8'))).toStrictEqual({
    from: 'harbor-refactor',
    sender: { kind: 'session', session: 's-7', name: 'harbor-refactor' },
  });

  expect(daemon.requests.slice(1)).toStrictEqual([
    {
      m: 'session.message',
      p: { session: 's-7', text: 'is the build green?', from: 'someone-else' },
    },
    { m: 'message.get', p: { message: 'm-3' } },
  ]);
});

test('it writes the sender the daemon recorded for a message it sent as a principal', async () => {
  const ctx = setupTest();

  startStubLegacyDaemon(ctx.socketPath, {
    replies: {
      'session.message': { message: 'm-3', status: 'queued' },
      'message.get': {
        from: 'Lantern Notes',
        sender: { kind: 'connector', client: 'client-7', name: 'Lantern Notes' },
      },
    },
  });

  await runCommand([process.execPath, ctx.probe, 'message-as', ctx.socketPath, 's-7', ctx.outPath]);

  expect(JSON.parse(readFileSync(ctx.outPath, 'utf8'))).toStrictEqual({
    from: 'Lantern Notes',
    sender: { kind: 'connector', client: 'client-7', name: 'Lantern Notes' },
  });
});

test('it gives the session in its handshake', async () => {
  const ctx = setupTest();
  const daemon = startStubLegacyDaemon(ctx.socketPath);

  await runCommand([process.execPath, ctx.probe, 'hello', ctx.socketPath, 's-7', ctx.outPath]);

  expect(JSON.parse(readFileSync(ctx.outPath, 'utf8'))).toStrictEqual({ ok: true });

  expect(daemon.requests).toStrictEqual([
    {
      m: 'daemon.hello',
      p: { client: 'atc/peer-probe', auth: { scheme: 'none' }, session: 's-7' },
    },
  ]);
});

test('it counts the bytes an events socket sent before it closed', async () => {
  const ctx = setupTest();

  const server = Bun.listen({
    unix: ctx.socketPath,
    socket: {
      open(socket) {
        socket.write('{"ev":"x"}\n');
      },

      // The probe's line shows that its connect completed.
      data(socket) {
        socket.end();
      },
    },
  });

  registerTestCleanup(() => {
    server.stop(true);
  });

  await runCommand([process.execPath, ctx.probe, 'events', ctx.socketPath, 's-7', ctx.outPath]);

  expect(JSON.parse(readFileSync(ctx.outPath, 'utf8'))).toStrictEqual({ bytes: 11 });
});

test('it counts no bytes for an events socket that closes as it connects', async () => {
  const ctx = setupTest();

  const server = Bun.listen({
    unix: ctx.socketPath,
    socket: {
      open(socket) {
        socket.end();
      },
      data() {},
    },
  });

  registerTestCleanup(() => {
    server.stop(true);
  });

  await runCommand([process.execPath, ctx.probe, 'events', ctx.socketPath, 's-7', ctx.outPath]);

  expect(JSON.parse(readFileSync(ctx.outPath, 'utf8'))).toStrictEqual({ bytes: 0 });
});

test('it writes no outcome when no events socket listens', async () => {
  const ctx = setupTest();

  const run = await runCommand([
    process.execPath,
    ctx.probe,
    'events',
    ctx.socketPath,
    's-7',
    ctx.outPath,
  ]);

  expect(run.exitCode).toBe(1);
  expect(existsSync(ctx.outPath)).toBeFalse();
});
