import { expect, test } from 'bun:test';
import { findMissingFeature } from './find-missing-feature';

test('it finds a listed field that the daemon lacks the feature for', () => {
  expect(findMissingFeature('events.read', { from: 'start' }, [])).toStrictEqual({
    field: 'from',
    feature: 'events.read.from-start',
  });
});

test('it finds nothing when the daemon lists the feature', () => {
  expect(
    findMissingFeature('events.read', { from: 'start' }, ['events.read.from-start']),
  ).toBeNull();
});

test('it finds nothing when the listed field is undefined', () => {
  expect(findMissingFeature('events.read', { from: undefined, limit: 5 }, [])).toBeNull();
});

test('it finds nothing for a method with no listed field', () => {
  expect(findMissingFeature('session.list', { from: 'start' }, [])).toBeNull();
});
