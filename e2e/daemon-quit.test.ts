import { expect, test } from 'bun:test';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';

/**
 * An `atc daemon` process on a fresh home, with a client that has sent its
 * handshake.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-e2e-quit-');
  const daemon = startDaemonProcess({ command: resolveATCCommand(), home: tmp.dir });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  return { daemon, client };
}

test('it stops the daemon process on daemon.quit', async () => {
  const ctx = await setupTest();
  const answer = await ctx.client.sendRequest('daemon.quit');
  const code = await ctx.daemon.proc.exited;

  expect(answer).toStrictEqual({});
  expect(code).toBe(0);
});
