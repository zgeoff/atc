import { expect, test } from 'bun:test';
import { fitNameAroundMatch } from './fit-name-around-match';

test.each([
  {
    title: 'a name that fits, as it is',
    name: 'tango',
    width: 8,
    jump: { typed: 't', label: 's' },
    expected: { text: 'tango   ', match: { start: 0, end: 1 } },
  },
  {
    title: 'a long name cut at its end when the match and label show',
    name: 'tango-orders-refactor',
    width: 10,
    jump: { typed: 't', label: 's' },
    expected: { text: 'tango-ord…', match: { start: 0, end: 1 } },
  },
  {
    title: 'a long name that keeps the match and label by dropping its start',
    name: `${'z'.repeat(24)}-tango`,
    width: 10,
    jump: { typed: 't', label: 's' },
    expected: { text: '…zzzzz-ta…', match: { start: 7, end: 8 } },
  },
  {
    title: 'room for the label after a match that ends the name',
    name: `${'z'.repeat(24)}-kit`,
    width: 8,
    jump: { typed: 't', label: 's' },
    expected: { text: '…zz-kit ', match: { start: 6, end: 7 } },
  },
  {
    title: 'the end of a match too long for the width, with room for its label',
    name: 'abcdefgh',
    width: 8,
    jump: { typed: 'abcdefgh', label: 'a' },
    expected: { text: '…cdefgh ', match: { start: 1, end: 7 } },
  },
  {
    title: 'the end of a match too long for the width, with a two-letter label and a cut end',
    name: 'abcdefghijk',
    width: 8,
    jump: { typed: 'abcdefgh', label: 'as' },
    expected: { text: '…efghijk', match: { start: 1, end: 5 } },
  },
  {
    title: 'a long name cut as usual while nothing is typed',
    name: 'orders-refactor',
    width: 8,
    jump: { typed: '', label: null },
    expected: { text: 'orders-…', match: null },
  },
])('#fitNameAroundMatch gives $title', (row) => {
  expect(fitNameAroundMatch(row.name, row.width, row.jump)).toStrictEqual(row.expected);
});
