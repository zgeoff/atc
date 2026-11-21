import { expect, test } from 'bun:test';
import { pickJumpLabels } from './pick-jump-labels';

test.each([
  {
    title: 'the letters no name holds, with nothing typed',
    names: ['api', 'app', 'web'],
    typed: '',
    expected: ['s', 'd', 'f'],
  },
  {
    title: 'the letters that do not follow a match, after a letter is typed',
    names: ['api', 'app'],
    typed: 'p',
    expected: ['a', 's'],
  },
  {
    title: 'every occurrence of the typed text, not only the first',
    names: ['pap', 'apx'],
    typed: 'p',
    expected: ['s', 'd'],
  },
  {
    title: 'a case-insensitive match of the typed text',
    names: ['Aab'],
    typed: 'A',
    expected: ['s'],
  },
  {
    title: 'two-letter labels when there are more names than free letters',
    names: Array.from({ length: 30 }, (_, index) => `n${index}`),
    typed: '',
    expected: ['aa', 'as', 'ad'],
  },
  {
    title: 'no label for a name past the two-letter labels',
    names: Array.from({ length: 2 }, () => 'abcdefghijklmnopqrstuvwxyz'),
    typed: '',
    expected: [null, null],
  },
])('#pickJumpLabels gives $title', (row) => {
  expect(pickJumpLabels(row.names, row.typed).slice(0, row.expected.length)).toStrictEqual([
    ...row.expected,
  ]);
});

test('#pickJumpLabels gives each label of 30 names once', () => {
  const labels = pickJumpLabels(
    Array.from({ length: 30 }, (_, index) => `n${index}`),
    '',
  );

  expect(new Set(labels).size).toBe(30);
});
