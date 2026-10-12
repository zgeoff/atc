import { expect, test } from 'bun:test';
import { buildShortName } from './build-short-name';

test.each([
  ['8F3A-12bc-Z9', 20, '8f3a12bcz9'],
  ['8F3A-12bc-Z9', 4, '8f3a'],
  ['--__..', 20, ''],
])(
  'it keeps the lowercased letters and digits of %s up to %d of them',
  (value, length, expected) => {
    expect(buildShortName(value, length)).toBe(expected);
  },
);
