import { expect, test } from 'bun:test';
import { truncateSummary } from './truncate-summary';

test('it flattens a multi-line result onto one line', () => {
  expect(truncateSummary('first line\nsecond line')).toBe('first line second line');
});

test('it keeps a 200-character result whole', () => {
  expect(truncateSummary('a'.repeat(200))).toBe('a'.repeat(200));
});

test('it cuts a longer result to 199 characters and an ellipsis', () => {
  expect(truncateSummary('a'.repeat(201))).toBe(`${'a'.repeat(199)}…`);
});
