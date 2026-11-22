import { expect, test } from 'bun:test';
import { buildJumpPlan } from './build-jump-plan';

test.each([
  {
    title: 'every row lit and no label with nothing typed',
    names: ['tui', 'cat', 'web'],
    typed: '',
    expected: { matches: [true, true, true], labels: [null, null, null] },
  },
  {
    title: 'the rows that hold the letter lit, each with a label, and the rest faded',
    names: ['tui', 'cat', 'web'],
    typed: 't',
    expected: { matches: [true, true, false], labels: ['a', 's', null] },
  },
  {
    title: 'a match anywhere in a name, with case ignored',
    names: ['Alpha', 'beta', 'zed'],
    typed: 'ET',
    expected: { matches: [false, true, false], labels: [null, 's', null] },
  },
  {
    title: 'every row faded when none matches',
    names: ['tui', 'web'],
    typed: 'q',
    expected: { matches: [false, false], labels: [null, null] },
  },
])('#buildJumpPlan gives $title', (row) => {
  expect(buildJumpPlan(row.names, row.typed)).toStrictEqual(row.expected);
});
