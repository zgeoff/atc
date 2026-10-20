import { expect, test } from 'bun:test';
import { startDaemonProcess } from '@atc/lifecycle/testing';
import { resolveATCCommand, setupTempDir } from '@atc/test-utils';

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
