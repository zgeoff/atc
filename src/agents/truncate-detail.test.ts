import { expect, test } from 'bun:test';
import { truncateDetail } from './truncate-detail';

test('it returns text under the cap unchanged', () => {
  expect(truncateDetail('short message')).toBe('short message');
});

test('it ellipsizes text over the 600-character cap', () => {
  const text = 'a'.repeat(700);
  const result = truncateDetail(text);

  expect(result).toHaveLength(600);
  expect(result).toBe(`${'a'.repeat(599)}…`);
});
