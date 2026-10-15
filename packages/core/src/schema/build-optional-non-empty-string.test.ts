import { expect, test } from 'bun:test';
import { buildOptionalNonEmptyString } from './build-optional-non-empty-string';

test('it keeps a non-empty string', () => {
  expect(buildOptionalNonEmptyString().parse('claude')).toBe('claude');
});

test.each([[''], [7], [null], [undefined], [['a']]])('it parses %p as undefined', (value) => {
  expect(buildOptionalNonEmptyString().parse(value)).toBeUndefined();
});
