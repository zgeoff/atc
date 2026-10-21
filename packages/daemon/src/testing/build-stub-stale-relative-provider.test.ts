import { expect, test } from 'bun:test';
import { RESOLVE_HOME_SCRIPT } from '../sessions/create-host-dir-claims';
import { buildStubStaleRelativeProvider } from './build-stub-stale-relative-provider';

test('it answers the home lookup with /home/guest', async () => {
  const provider = buildStubStaleRelativeProvider();

  const result = await provider.runCommand({
    argv: ['sh', '-c', RESOLVE_HOME_SCRIPT],
    cwd: '/',
    host: 'host-1',
  });

  expect(result).toStrictEqual({ exitCode: 0, stdout: '/home/guest\n', stderr: '' });
});

test('it fails a command that runs in a relative directory', async () => {
  const provider = buildStubStaleRelativeProvider();

  const result = await provider.runCommand({
    argv: ['sh', '-c', 'pwd -P', 'sh', 'old-notes'],
    cwd: 'old-notes',
    host: 'host-1',
  });

  expect(result).toStrictEqual({ exitCode: 1, stdout: '', stderr: 'no such directory\n' });
});

test('it echoes the fourth argument of any other command as a resolved directory', async () => {
  const provider = buildStubStaleRelativeProvider();

  const result = await provider.runCommand({
    argv: ['sh', '-c', 'pwd -P', 'sh', '/home/guest/work/a'],
    cwd: '/',
    host: 'host-1',
  });

  expect(result).toStrictEqual({ exitCode: 0, stdout: '/home/guest/work/a\n\0', stderr: '' });
});

test('it reports a remote host that can suspend and destroy', () => {
  const provider = buildStubStaleRelativeProvider();

  expect(provider.capabilities.suspend).toBeTrue();
  expect(provider.capabilities.destroy).toBeTrue();
});
