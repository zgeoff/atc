import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { updateEnv } from '../test-utils/update-env';
import { logClientEvent } from './log-client-event';

function setupTest() {
  const tmp = setupTempDir('atc-client-log-');

  return { dir: tmp.dir };
}

test('it appends each line to the file the variable holds', () => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'client.log');

  updateEnv('ATC_CLIENT_LOG', path);
  logClientEvent('dropped probe answer');
  logClientEvent('ignored tab with one source');

  expect(readFileSync(path, 'utf8')).toBe('dropped probe answer\nignored tab with one source\n');
});

test('it keeps going when the file cannot be written', () => {
  const ctx = setupTest();

  updateEnv('ATC_CLIENT_LOG', join(ctx.dir, 'missing', 'client.log'));

  expect(() => {
    logClientEvent('dropped probe answer');
  }).not.toThrow();
});

test.each([
  ['unset', undefined],
  ['empty', ''],
])('it writes nothing while the variable is %s', (_case, value) => {
  const ctx = setupTest();
  const path = join(ctx.dir, 'client.log');

  updateEnv('ATC_CLIENT_LOG', path);
  logClientEvent('dropped probe answer');
  updateEnv('ATC_CLIENT_LOG', value);
  logClientEvent('ignored tab with one source');

  expect(readFileSync(path, 'utf8')).toBe('dropped probe answer\n');
});
