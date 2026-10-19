import { expect, mock, test } from 'bun:test';
import { buildMockHostServices } from '@atc/test-utils';
import { readZoxideDirs } from './read-zoxide-dirs';

test("it lists zoxide's directories, most visited first", async () => {
  const run = mock(() =>
    Promise.resolve({ code: 0, stdout: '/home/me/a\n/home/me/b', stderr: '', aborted: false }),
  );

  const dirs = await readZoxideDirs(run);

  expect(dirs).toStrictEqual(['/home/me/a', '/home/me/b']);
  expect(run).toHaveBeenCalledExactlyOnceWith(['zoxide', 'query', '-l']);
});

test('it lists nothing on a host without zoxide', async () => {
  const host = buildMockHostServices();

  const dirs = await readZoxideDirs(host.runCommand);

  expect(dirs).toStrictEqual([]);
});

test('it lists nothing when the zoxide query fails', async () => {
  const run = mock(() =>
    Promise.resolve({ code: 1, stdout: '/home/me/a', stderr: 'no database', aborted: false }),
  );

  const dirs = await readZoxideDirs(run);

  expect(dirs).toStrictEqual([]);
});
