import { expect, test } from 'bun:test';
import { mintGrantID } from './mint-grant-id';

test('it mints a g- prefixed uuid id', () => {
  const id = mintGrantID();

  expect(id).toMatch(/^g-[0-9a-f-]{36}$/);
});
