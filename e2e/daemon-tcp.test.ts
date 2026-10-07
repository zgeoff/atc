import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DaemonClient } from '../src/client/daemon-client';
import { findDaemonRecord } from '../src/shared/find-daemon-record';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';

/**
 * An `atc daemon` process on a fresh home with a TCP listener whose token
 * file accepts two tokens, 32 `a`s and 32 `b`s. `port` is the port the
 * listener bound, and `tokenFile` the file a SIGHUP reloads.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-e2e-tcp-'));
  const tokenFile = join(tmp.dir, 'gateway-token');

  // The daemon refuses to start its TCP listener without a token file.
  writeFileSync(tokenFile, `${'a'.repeat(32)}\n${'b'.repeat(32)}\n`);

  // Port 0 leaves the pick to the kernel, which holds the port from the bind
  // on; a port the test picked and freed could be taken by another socket
  // before the daemon binds it.
  const daemon = stack.use(
    startDaemonProcess({
      command: resolveATCCommand(),
      home: tmp.dir,
      args: ['--listen', '127.0.0.1:0', '--token-file', tokenFile],
    }),
  );

  // A hello answered over the unix socket means startup has returned: the
  // TCP listener is bound, the record holds its port, and the SIGHUP
  // handler is in place.
  const local = await daemon.openClient();

  await local.sendHello('atc/test');

  const port = z
    .number()
    .int()
    .parse(findDaemonRecord(join(daemon.stateDir, 'daemon.json'))?.listenPort);

  const owned = stack.move();

  return { daemon, tokenFile, port, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it closes a TCP connection whose token a SIGHUP reload removed', async () => {
  await using ctx = await setupTest();

  const tcp = await DaemonClient.open({ hostname: '127.0.0.1', port: ctx.port });

  onTestFinished(() => {
    tcp.stop();
  });

  const closed = Promise.withResolvers<void>();

  tcp.onClose = () => {
    closed.resolve();
  };

  await tcp.sendHello('atc/test-gateway', 'a'.repeat(32));

  writeFileSync(ctx.tokenFile, `${'b'.repeat(32)}\n`);

  ctx.daemon.proc.kill('SIGHUP');

  await closed.promise;

  expect(tcp.sendRequest('session.list')).rejects.toMatchObject({ code: 'internal' });
});

test('it accepts a TCP handshake with a token a SIGHUP reload kept', async () => {
  await using ctx = await setupTest();

  const removed = await DaemonClient.open({ hostname: '127.0.0.1', port: ctx.port });

  onTestFinished(() => {
    removed.stop();
  });

  const reloaded = Promise.withResolvers<void>();

  removed.onClose = () => {
    reloaded.resolve();
  };

  await removed.sendHello('atc/test-gateway', 'a'.repeat(32));

  writeFileSync(ctx.tokenFile, `${'b'.repeat(32)}\n`);

  ctx.daemon.proc.kill('SIGHUP');

  // The connection on the removed token closes once the reload has applied.
  await reloaded.promise;

  const kept = await DaemonClient.open({ hostname: '127.0.0.1', port: ctx.port });

  onTestFinished(() => {
    kept.stop();
  });

  const hello = await kept.sendHello('atc/test-gateway', 'b'.repeat(32));

  expect(hello).toStrictEqual({
    // The build string differs between this checkout and a compiled binary.
    daemon: expect.stringMatching(/^atc\//u),
    daemonID: expect.stringMatching(/^[\da-f-]{36}$/u),
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    features: [
      'agents.list',
      'events.more',
      'events.session',
      'message.turn',
      'message.wait',
      'spawn.options',
      'daemon.id',
      'session.locator',
      'spawn.idempotency',
      'message.idempotency',
      'spawn.target',
      'request.principal',
      'spawn.workspace',
      'spawn.workspace.trust',
      'spawn.workspace.autoDir',
      'session.forget',
      'session.forget.preconditions',
      'session.submit',
      'report.get',
      'sources',
      'git.probe',
      'transport.tcp',
      'idempotency.replayOnly',
      'session.auth',
    ],
    idempotency: { completedRetentionMs: 86_400_000 },
    lastUsedAgent: 'claude',
  });
});
