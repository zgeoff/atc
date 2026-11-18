import { expect, test } from 'bun:test';
import { resolveATCCommand } from '@atc/core/test-utils/resolve-atc-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { startDaemonProcess } from '@atc/lifecycle/test-utils/start-daemon-process';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-quit-');

  const daemon = startDaemonProcess({
    command: resolveATCCommand(),
    home: temporaryDirectory.path,
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  return { daemon, client };
}

test('it stops the daemon process on daemon.quit', async () => {
  const ctx = await setupTest();
  const answer = await ctx.client.sendRequest('daemon.quit');
  const code = await ctx.daemon.subprocess.exited;

  expect(answer).toStrictEqual({});
  expect(code).toBe(0);
});
