import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand } from '@atc/test-utils';

test.each([
  ['a newer published version', '7.10.0\n7.3.1\n', '7.10.0\n'],
  ['an equal version', '7.3.1\n7.3.1\n', '7.3.1\n'],
  ['an older published version', '7.3.0\n7.3.1\n', '7.3.1\n'],
  ['a blank line beside one version', '\n7.3.1\n', '7.3.1\n'],
  ['no version', '', ''],
])('it prints the newest version given %s', async (_label, stdin, expected) => {
  const picked = await runCommand(['bash', join(import.meta.dir, 'pick-newest-version.sh')], {
    stdin,
  });

  expect({ exitCode: picked.exitCode, stdout: picked.stdout, stderr: picked.stderr }).toStrictEqual(
    { exitCode: 0, stdout: expected, stderr: '' },
  );
});
