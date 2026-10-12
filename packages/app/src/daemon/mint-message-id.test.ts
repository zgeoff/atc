import { expect, test } from 'bun:test';
import { mintMessageID } from './mint-message-id';

test('it mints an m- prefixed uuid id', () => {
  const id = mintMessageID();

  expect(id).toMatch(/^m-[0-9a-f-]{36}$/);
});

test('it never mints the same id twice in a row', () => {
  const first = mintMessageID();
  const second = mintMessageID();

  expect(second).not.toBe(first);
});
