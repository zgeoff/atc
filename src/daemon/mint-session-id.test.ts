import { expect, test } from 'bun:test';
import { mintSessionID } from './mint-session-id';

test('it mints a counter-and-timestamp id', () => {
  const id = mintSessionID();

  expect(id).toMatch(/^s\d+-[0-9a-z]+$/);
});

test('it never mints the same id twice in a row', () => {
  const first = mintSessionID();
  const second = mintSessionID();

  expect(second).not.toBe(first);
});
