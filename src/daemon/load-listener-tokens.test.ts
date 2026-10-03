import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { loadListenerTokens } from './load-listener-tokens';

test('it loads one token with a final newline', () => {
  using tmp = setupTempDir('atc-listener-tokens-');

  const path = join(tmp.dir, 'gateway-token');

  writeFileSync(path, `${'a'.repeat(32)}\n`);

  expect(loadListenerTokens(path)).toStrictEqual({ ok: true, tokens: ['a'.repeat(32)] });
});

test('it loads two tokens and trims the whitespace around each', () => {
  using tmp = setupTempDir('atc-listener-tokens-');

  const path = join(tmp.dir, 'gateway-token');

  writeFileSync(path, `${'a'.repeat(32)}\r\n  ${'b'.repeat(48)}  `);

  expect(loadListenerTokens(path)).toStrictEqual({
    ok: true,
    tokens: ['a'.repeat(32), 'b'.repeat(48)],
  });
});

test('it refuses a file that does not exist', () => {
  using tmp = setupTempDir('atc-listener-tokens-');

  const path = join(tmp.dir, 'missing');

  expect(loadListenerTokens(path)).toStrictEqual({
    ok: false,
    reason: expect.toStartWith(`cannot read ${path}:`),
  });
});

test.each([
  ['an empty file', ''],
  ['a short token', `${'a'.repeat(31)}\n`],
  ['a blank line between tokens', `${'a'.repeat(32)}\n\n${'b'.repeat(32)}\n`],
  ['a second final newline', `${'a'.repeat(32)}\n\n`],
])('it refuses %s', (_label, content) => {
  using tmp = setupTempDir('atc-listener-tokens-');

  const path = join(tmp.dir, 'gateway-token');

  writeFileSync(path, content);

  expect(loadListenerTokens(path)).toStrictEqual({
    ok: false,
    reason: `${path} holds a token under 32 bytes or a blank line`,
  });
});

test('it refuses a third token', () => {
  using tmp = setupTempDir('atc-listener-tokens-');

  const path = join(tmp.dir, 'gateway-token');

  writeFileSync(path, `${'a'.repeat(32)}\n${'b'.repeat(32)}\n${'c'.repeat(32)}\n`);

  expect(loadListenerTokens(path)).toStrictEqual({
    ok: false,
    reason: `${path} holds 3 lines; it takes one or two tokens`,
  });
});
