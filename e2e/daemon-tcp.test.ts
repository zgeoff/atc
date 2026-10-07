import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../src/client/daemon-client';
import { findDaemonRecord } from '../src/shared/find-daemon-record';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';

/**
 * A fresh home for a daemon with a TCP listener, and the path its token
 * file takes there; a daemon that finds no config there writes its own on
 * first run.
 */
function setupTest() {
  const tmp = setupTempDir('atc-e2e-tcp-');

  return {
    home: tmp.dir,
    atc: resolveATCCommand(),
    tokenFile: join(tmp.dir, 'gateway-token'),
    [Symbol.dispose]: tmp[Symbol.dispose],
  };
}

test('it closes a TCP connection whose token a SIGHUP reload removed', async () => {
  using ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n${'b'.repeat(32)}\n`);

  // Port 0 leaves the pick to the kernel, which holds the port from the bind
  // on; a port the test picked and freed could be taken by another socket
  // before the daemon binds it.
  await using daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    args: ['--listen', '127.0.0.1:0', '--token-file', ctx.tokenFile],
  });

  // A hello answered over the unix socket means startup has returned: the
  // TCP listener is bound, the record holds its port, and the SIGHUP
  // handler is in place.
  const local = await daemon.openClient();

  await local.sendHello('atc/test');

  const record = findDaemonRecord(join(daemon.stateDir, 'daemon.json'));

  if (record?.listenPort === undefined || record.listenPort === null) {
    throw new Error('daemon.json holds no listen port');
  }

  const tcp = await DaemonClient.open({ hostname: '127.0.0.1', port: record.listenPort });

  onTestFinished(() => {
    tcp.stop();
  });

  const closed = Promise.withResolvers<void>();

  tcp.onClose = () => {
    closed.resolve();
  };

  await tcp.sendHello('atc/test-gateway', 'a'.repeat(32));

  writeFileSync(ctx.tokenFile, `${'b'.repeat(32)}\n`);

  daemon.proc.kill('SIGHUP');

  await closed.promise;

  expect(tcp.sendRequest('session.list')).rejects.toMatchObject({ code: 'internal' });
});

test('it accepts a TCP handshake with a token a SIGHUP reload kept', async () => {
  using ctx = setupTest();

  writeFileSync(ctx.tokenFile, `${'a'.repeat(32)}\n${'b'.repeat(32)}\n`);

  await using daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    args: ['--listen', '127.0.0.1:0', '--token-file', ctx.tokenFile],
  });

  const local = await daemon.openClient();

  await local.sendHello('atc/test');

  const record = findDaemonRecord(join(daemon.stateDir, 'daemon.json'));

  if (record?.listenPort === undefined || record.listenPort === null) {
    throw new Error('daemon.json holds no listen port');
  }

  const removed = await DaemonClient.open({ hostname: '127.0.0.1', port: record.listenPort });

  onTestFinished(() => {
    removed.stop();
  });

  const reloaded = Promise.withResolvers<void>();

  removed.onClose = () => {
    reloaded.resolve();
  };

  await removed.sendHello('atc/test-gateway', 'a'.repeat(32));

  writeFileSync(ctx.tokenFile, `${'b'.repeat(32)}\n`);

  daemon.proc.kill('SIGHUP');

  // The connection on the removed token closes once the reload has applied.
  await reloaded.promise;

  const kept = await DaemonClient.open({ hostname: '127.0.0.1', port: record.listenPort });

  onTestFinished(() => {
    kept.stop();
  });

  const hello = await kept.sendHello('atc/test-gateway', 'b'.repeat(32));

  expect(hello).toContainKey('daemonID');
});
