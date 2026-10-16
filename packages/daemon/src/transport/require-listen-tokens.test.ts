import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { requireListenTokens } from './require-listen-tokens';

// A temporary folder for the token file.
function setupTest() {
  const tmp = setupTempDir('atc-listen-tokens-');

  return { dir: tmp.dir };
}

test('it loads the tokens of a loopback listener', async () => {
  const ctx = setupTest();
  const tokenFile = join(ctx.dir, 'tokens');

  await Bun.write(tokenFile, 'a-listener-token-of-forty-bytes-or-so-0001\n');

  expect(requireListenTokens({ host: '127.0.0.1', tokenFile })).toStrictEqual([
    'a-listener-token-of-forty-bytes-or-so-0001',
  ]);
});

test('it refuses a wildcard bind before it reads the token file', () => {
  const ctx = setupTest();

  expect(() =>
    requireListenTokens({ host: '0.0.0.0', tokenFile: join(ctx.dir, 'missing') }),
  ).toThrowWithMessage(Error, /^atc daemon: .*0\.0\.0\.0/);
});

test('it refuses a token file that fails to load', () => {
  const ctx = setupTest();

  expect(() =>
    requireListenTokens({ host: '127.0.0.1', tokenFile: join(ctx.dir, 'missing') }),
  ).toThrowWithMessage(Error, /^atc daemon: --token-file: cannot read /);
});
