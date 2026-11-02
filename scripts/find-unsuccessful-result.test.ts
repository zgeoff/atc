import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand } from '@atc/test-utils';
import { findUnsuccessfulResult } from './find-unsuccessful-result';

test.each([
  ['success success', null],
  ['success skipped', 'skipped'],
  ['failure success', 'failure'],
  ['success cancelled', 'cancelled'],
  ['', null],
])('it finds the first result other than success in %p: %p', (results, expected) => {
  expect(findUnsuccessfulResult(results)).toBe(expected);
});

test('it fails the gate and names the result when a required job was skipped', async () => {
  const gate = await runCommand(
    [process.execPath, join(import.meta.dir, 'find-unsuccessful-result.ts')],
    { env: { ...process.env, RESULTS: 'success skipped' } },
  );

  expect({ exitCode: gate.exitCode, stdout: gate.stdout, stderr: gate.stderr }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'a required job ended as skipped\n',
  });
});

test('it passes the gate when every required job succeeded', async () => {
  const gate = await runCommand(
    [process.execPath, join(import.meta.dir, 'find-unsuccessful-result.ts')],
    { env: { ...process.env, RESULTS: 'success success' } },
  );

  expect({ exitCode: gate.exitCode, stdout: gate.stdout, stderr: gate.stderr }).toStrictEqual({
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
});
