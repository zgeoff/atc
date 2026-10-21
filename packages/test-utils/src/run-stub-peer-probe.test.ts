import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';
import { startStubLegacyDaemon } from './start-stub-legacy-daemon';

// A socket path and an output path in a fresh temp directory, and the probe
// script's path.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-peer-probe-');

  return {
    socketPath: join(temporaryDirectory.path, 'daemon.sock'),
    outPath: join(temporaryDirectory.path, 'probe.json'),
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
    {
      method: 'daemon.hello',
      params: { client: 'atc/peer-probe', protocol: 10, auth: { scheme: 'none' } },
    },
    { method: 'session.scope.add', params: { session: 's-7', scope: {} } },
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
      method: 'session.message',
      params: { session: 's-7', text: 'is the build green?', from: 'someone-else' },
    },
    { method: 'message.get', params: { message: 'm-3' } },
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
      method: 'daemon.hello',
      params: { client: 'atc/peer-probe', protocol: 10, auth: { scheme: 'none' }, session: 's-7' },
    },
  ]);
});
