import { expect, test } from 'bun:test';
import { buildImpdLease } from './build-impd-lease';

test('it builds a lease held by a principal until a time', () => {
  expect(buildImpdLease('imp-a', 'atc-daemon', 'atc-d1', 1_700_000_000_000)).toStrictEqual({
    name: 'imp-a',
    owner: { principal: 'atc-daemon', display: 'atc-daemon', label: 'atc-d1' },
    until: new Date(1_700_000_000_000),
  });
});
