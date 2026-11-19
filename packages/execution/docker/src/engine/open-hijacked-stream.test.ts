import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { openHijackedStream } from './open-hijacked-stream';

function setupTest(reply: string) {
  const directory = setupTempDir('atc-hijack-');
  const socketPath = join(directory.path, 'engine.sock');

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data: (socket) => {
        socket.write(reply);
        socket.end();
      },
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  return { open: () => openHijackedStream(socketPath, '/containers/c1/attach') };
}

test('it hands a listener the output that arrived in the chunk of the headers', async () => {
  const ctx = setupTest(
    'HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nFIRST_SCREEN',
  );

  const attachment = await ctx.open();

  const received: string[] = [];

  attachment.onData((data) => {
    received.push(new TextDecoder().decode(data));
  });

  expect(received.join('')).toBe('FIRST_SCREEN');
});

test('it refuses a request the Engine answers with an error status', async () => {
  const ctx = setupTest('HTTP/1.1 404 Not Found\r\n\r\n');

  await expect(ctx.open()).rejects.toThrow(/status 404/u);
});
