import { expect, test } from 'bun:test';
import { mintClientID } from './mint-client-id';

test('it mints a c- prefixed uuid id', () => {
  const id = mintClientID();

  expect(id).toMatch(/^c-[0-9a-f-]{36}$/);
});
