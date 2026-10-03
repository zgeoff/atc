import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { readImpToken } from './read-imp-token';

test('it reads a token file without its one trailing newline', () => {
  using tmp = setupTempDir('atc-read-imp-token-');

  const tokenPath = join(tmp.dir, 'imp-token');

  writeFileSync(tokenPath, 'file-token\n\n');

  expect(readImpToken(tokenPath)).toBe('file-token\n');
});

test('it reads a token file without a trailing newline as written', () => {
  using tmp = setupTempDir('atc-read-imp-token-');

  const tokenPath = join(tmp.dir, 'imp-token');

  writeFileSync(tokenPath, 'file-token');

  expect(readImpToken(tokenPath)).toBe('file-token');
});

test('it refuses an empty token file as unauthorized', () => {
  using tmp = setupTempDir('atc-read-imp-token-');

  const tokenPath = join(tmp.dir, 'imp-token');

  writeFileSync(tokenPath, '\n');

  expect(() => readImpToken(tokenPath)).toThrow(
    expect.objectContaining({
      code: 'UNAUTHORIZED',
      message: `the impd token file ${tokenPath} is empty`,
    }),
  );
});

test('it refuses a missing token file as unauthorized, giving the read error code', () => {
  using tmp = setupTempDir('atc-read-imp-token-');

  const tokenPath = join(tmp.dir, 'imp-token');

  expect(() => readImpToken(tokenPath)).toThrow(
    expect.objectContaining({
      code: 'UNAUTHORIZED',
      message: `cannot read the impd token file ${tokenPath}: ENOENT`,
    }),
  );
});
