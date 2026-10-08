import { expect, test } from 'bun:test';
import { tryBindAddresses } from './try-bind-addresses';

test('it can bind the loopback address every host has', () => {
  expect(tryBindAddresses(['127.0.0.1'])).toBeTrue();
});

test('it cannot bind a documentation address no interface holds', () => {
  expect(tryBindAddresses(['127.0.0.1', '192.0.2.1'])).toBeFalse();
});
