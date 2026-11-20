import { expect, test } from 'bun:test';
import { findMissingFeature } from './find-missing-feature';

test('it finds a listed field that is present when the daemon lacks its feature', () => {
  expect(findMissingFeature('events.read', { from: 'start' }, [])).toStrictEqual({
    field: 'from',
    feature: 'events.read.from-start',
  });
});

test.each([
  ['the daemon lists the feature', { from: 'start' }, ['events.read.from-start']],
  ['the field is absent', { waitMs: 5 }, []],
  ['the field is undefined', { from: undefined }, []],
  ['the input is not an object', undefined, []],
])('it finds nothing when %s', (_name, input, features) => {
  expect(findMissingFeature('events.read', input, features)).toBeNull();
});

test('it finds nothing for a method with no listed field', () => {
  expect(findMissingFeature('session.list', { from: 'start' }, [])).toBeNull();
});
