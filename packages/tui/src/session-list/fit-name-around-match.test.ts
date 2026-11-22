import { expect, test } from 'bun:test';
import { fitNameAroundMatch } from './fit-name-around-match';

test.each([
  {
    title: 'a name that fits, as it is',
    name: 'tango',
    width: 8,
    jump: { typed: 't', label: 's' },
    expected: 'tango   ',
  },
  {
    title: 'a long name cut at its end when the match and label show',
    name: 'tango-orders-refactor',
    width: 10,
    jump: { typed: 't', label: 's' },
    expected: 'tango-ord…',
  },
  {
    title: 'a long name that keeps the match and label by dropping its start',
    name: `${'z'.repeat(24)}-tango`,
    width: 10,
    jump: { typed: 't', label: 's' },
    expected: '…zzzzz-ta…',
  },
  {
    title: 'room for the label after a match that ends the name',
    name: `${'z'.repeat(24)}-kit`,
    width: 8,
    jump: { typed: 't', label: 's' },
    expected: '…zz-kit ',
  },
  {
    title: 'a long name cut as usual while nothing is typed',
    name: 'orders-refactor',
    width: 8,
    jump: { typed: '', label: null },
    expected: 'orders-…',
  },
])('#fitNameAroundMatch gives $title', (row) => {
  expect(fitNameAroundMatch(row.name, row.width, row.jump)).toBe(row.expected);
});
