import { expect, test } from 'bun:test';
import { buildMockIdempotencyRecord } from '../testing/build-mock-idempotency-record';
import { collectCompletedIdempotencyRecords } from './collect-completed-idempotency-records';

test.each([
  ['a completed key with a result', 'completed', '{"session":"s-1"}', ['k-1']],
  ['a completed key with no result', 'completed', null, []],
  ['a key in progress', 'in_progress', null, []],
  ['a key whose outcome is unknown', 'outcome_unknown', null, []],
] as const)('it collects %s as %p', (_label, state, result, expected) => {
  const records = [buildMockIdempotencyRecord({ key: 'k-1', state, result })];

  expect(collectCompletedIdempotencyRecords(records).map((record) => record.key)).toStrictEqual([
    ...expected,
  ]);
});
