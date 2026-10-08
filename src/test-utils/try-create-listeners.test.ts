import { expect, test } from 'bun:test';
import { tryCreateListeners } from './try-create-listeners';

test('it creates a listener on the loopback address every host has', () => {
  expect(tryCreateListeners(['127.0.0.1'])).toBeTrue();
});

test('it reports a failure for a documentation address no interface holds', () => {
  expect(tryCreateListeners(['127.0.0.1', '192.0.2.1'])).toBeFalse();
});
