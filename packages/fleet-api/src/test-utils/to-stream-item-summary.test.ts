import { expect, test } from 'bun:test';
import { withEventMeta } from '@orpc/server';
import { toStreamItemSummary } from './to-stream-item-summary';

test('it summarizes an event item by its kind and event id', () => {
  const item = withEventMeta({ kind: 'event', event: {} }, { id: 'g1.a' });

  expect(toStreamItemSummary(item)).toStrictEqual(['event', 'g1.a', null]);
});

test('it summarizes a daemons item with its lists', () => {
  const item = withEventMeta(
    { kind: 'daemons', unavailable: ['laptop'], started: [], truncated: [] },
    { id: 'g1.b' },
  );

  expect(toStreamItemSummary(item)).toStrictEqual(['daemons', 'g1.b', [['laptop'], []]]);
});
