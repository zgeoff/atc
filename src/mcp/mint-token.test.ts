import { expect, test } from 'bun:test';
import { mintToken } from './mint-token';

test('it mints a prefixed token with 32 bytes of base64url after the prefix', () => {
  expect(mintToken('atc_at_')).toMatch(/^atc_at_[\w-]{43}$/);
});

test('it never mints the same token twice in a row', () => {
  const first = mintToken('atc_rt_');
  const second = mintToken('atc_rt_');

  expect(second).not.toBe(first);
});
