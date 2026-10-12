import { expect, test } from 'bun:test';
import { mintSessionID } from './mint-session-id';

test('it mints a random uuid', () => {
  const id = mintSessionID();

  expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
});

test('it never mints the same id twice in a row', () => {
  const first = mintSessionID();
  const second = mintSessionID();

  expect(second).not.toBe(first);
});
