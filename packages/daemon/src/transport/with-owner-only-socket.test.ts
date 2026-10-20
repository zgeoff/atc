import { expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { withOwnerOnlySocket } from './with-owner-only-socket';

// A socket path in a fresh temp directory, under a umask that grants every
// bit, so a mode the helper did not set shows in the socket.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-owner-only-socket-');
  const previous = process.umask(0o000);

  registerTestCleanup(() => {
    process.umask(previous);
  });

  return { socketPath: join(temporaryDirectory.path, 'test.sock') };
}

test('it leaves a socket bound under a permissive umask readable and writable by its owner alone', () => {
  const ctx = setupTest();

  const server = withOwnerOnlySocket(ctx.socketPath, () =>
    Bun.listen({ unix: ctx.socketPath, socket: { data() {} } }),
  );

  registerTestCleanup(() => {
    server.stop(true);
  });

  expect(statSync(ctx.socketPath).mode & 0o777).toBe(0o600);
});

test('it restores the process umask after the bind', () => {
  const ctx = setupTest();

  const server = withOwnerOnlySocket(ctx.socketPath, () =>
    Bun.listen({ unix: ctx.socketPath, socket: { data() {} } }),
  );

  registerTestCleanup(() => {
    server.stop(true);
  });

  // Setting the umask returns the one it replaces; the bare read form is
  // deprecated because it writes the umask twice.
  expect(process.umask(0o000)).toBe(0o000);
});

test('it restores the process umask when the bind throws', () => {
  const ctx = setupTest();

  expect(() =>
    withOwnerOnlySocket(ctx.socketPath, () => {
      throw new Error('bind failed');
    }),
  ).toThrowWithMessage(Error, 'bind failed');

  // Setting the umask returns the one it replaces; the bare read form is
  // deprecated because it writes the umask twice.
  expect(process.umask(0o000)).toBe(0o000);
});
