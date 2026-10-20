import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { readPeerPID } from './read-peer-pid';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-peer-pid-');
  const socketPath = join(temporaryDirectory.path, 'peer.sock');
  const peer = Promise.withResolvers<number | null>();

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        peer.resolve(readPeerPID(socket));
      },
      data() {},
    },
  });

  registerTestCleanup(() => {
    server.stop(true);
  });

  return { socketPath, peer: peer.promise };
}

test.skipIf(process.platform !== 'linux')(
  'it reads the pid of the process that connected from the kernel',
  async () => {
    const ctx = setupTest();

    const subprocess = Bun.spawn(
      [
        process.execPath,
        '-e',
        `await Bun.connect({ unix: ${JSON.stringify(ctx.socketPath)}, socket: { data() {} } }); await Bun.sleep(30_000);`,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    );

    registerTestCleanup(async () => {
      subprocess.kill('SIGKILL');

      await subprocess.exited;
    });

    const peer = await ctx.peer;

    expect(peer).toBe(subprocess.pid);
  },
);

test.skipIf(process.platform === 'linux')(
  'it reads no pid on a platform without SO_PEERCRED',
  async () => {
    const ctx = setupTest();

    const client = await Bun.connect({ unix: ctx.socketPath, socket: { data() {} } });

    registerTestCleanup(() => {
      client.end();
    });

    const peer = await ctx.peer;

    expect(peer).toBeNull();
  },
);

test('it reads no pid from a socket without a descriptor', () => {
  expect(readPeerPID({})).toBeNull();
});
