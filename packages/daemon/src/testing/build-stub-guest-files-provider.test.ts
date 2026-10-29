import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { buildStubGuestFilesProvider } from './build-stub-guest-files-provider';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-guest-files-');

  return { directory: temporaryDirectory.path };
}

test('it reads a file at its guest path from the host folder', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'records'));
  writeFileSync(join(ctx.directory, 'records', 'worker.json'), 'kept in the guest');

  const provider = buildStubGuestFilesProvider({
    guestDirectory: '/guest/atc',
    hostDirectory: ctx.directory,
  });

  const result = await provider.runCommand({
    argv: ['cat', '/guest/atc/records/worker.json'],
    cwd: '/',
    host: 'host-1',
  });

  expect(result).toStrictEqual({ exitCode: 0, stdout: 'kept in the guest', stderr: '' });
});

test('it passes an argument outside the guest folder unchanged', async () => {
  const ctx = setupTest();

  const provider = buildStubGuestFilesProvider({
    guestDirectory: '/guest/atc',
    hostDirectory: ctx.directory,
  });

  const result = await provider.runCommand({
    argv: ['echo', '/guest/atcx', '/other/atc/notes'],
    cwd: '/',
    host: 'host-1',
  });

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: '/guest/atcx /other/atc/notes\n',
    stderr: '',
  });
});

test('it reports a remote host with the guest folder as its layout', async () => {
  const ctx = setupTest();

  const provider = buildStubGuestFilesProvider({
    guestDirectory: '/guest/atc',
    hostDirectory: ctx.directory,
  });

  const layout = await provider.readGuest?.('host-1');

  expect(provider.remote).toBeTrue();

  expect(layout).toStrictEqual({
    directory: '/guest/atc',
    atc: null,
  });
});
