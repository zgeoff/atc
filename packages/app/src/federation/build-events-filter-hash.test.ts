import { expect, test } from 'bun:test';
import { buildEventsFilterHash } from './build-events-filter-hash';

test('it hashes the same filters the same way whatever the kind order', () => {
  expect(buildEventsFilterHash('cloud.0f6c2a8e.s1', ['b', 'a'])).toBe(
    buildEventsFilterHash('cloud.0f6c2a8e.s1', ['a', 'b']),
  );
});

test('it hashes a session filter apart from no filter', () => {
  expect(buildEventsFilterHash('cloud.0f6c2a8e.s1', null)).not.toBe(
    buildEventsFilterHash(null, null),
  );
});

test('it hashes into 22 base64url characters', () => {
  expect(buildEventsFilterHash('cloud.0f6c2a8e.s1', ['state'])).toMatch(/^[\w-]{22}$/);
});
