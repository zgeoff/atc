import { expect, test } from 'bun:test';
import { fitText } from './fit-text';

test.each([
  { title: 'a short text as it is', text: 'api', width: 8, isPadded: false, expected: 'api' },
  { title: 'a short text padded', text: 'api', width: 6, isPadded: true, expected: 'api   ' },
  {
    title: 'a long text cut with an ellipsis',
    text: 'orders-refactor',
    width: 8,
    isPadded: false,
    expected: 'orders-…',
  },
  {
    title: 'a wide character counted as two columns',
    text: '界界界',
    width: 5,
    isPadded: true,
    expected: '界界…',
  },
  { title: 'a newline as a space', text: 'a\nb', width: 5, isPadded: false, expected: 'a b' },
  { title: 'nothing for no room', text: 'api', width: 0, isPadded: true, expected: '' },
])('#fitText gives $title', (row) => {
  expect(fitText(row.text, row.width, row.isPadded)).toBe(row.expected);
});
