import { expect, test } from 'bun:test';
import { pickJumpLabels } from './pick-jump-labels';

test.each([
  {
    title: 'no label while nothing is typed',
    names: ['api', 'app'],
    typed: '',
    expected: [null, null],
  },
  {
    title: 'the letters that do not follow a match',
    names: ['api', 'app'],
    typed: 'p',
    expected: ['a', 's'],
  },
  {
    title: 'letters that skip every one that follows any occurrence of the typed text',
    names: ['pap', 'apx'],
    typed: 'p',
    expected: ['s', 'd'],
  },
  {
    title: 'a case-insensitive match of the typed text',
    names: ['Aab', 'ab'],
    typed: 'A',
    expected: ['s', 'd'],
  },
  {
    title: 'no label for a name that ends at the match, besides its place after the name',
    names: ['cat', 'tui'],
    typed: 't',
    expected: ['a', 's'],
  },
  {
    title: 'no label while typing can isolate each of more rows than letters are free',
    names: [...Array.from('asdfghjklqwertyuiopzxcvbnm', (letter) => `t${letter}x`), 'tzy'],
    typed: 't',
    expected: Array.from({ length: 27 }, () => null),
  },
  {
    title: 'a label for a row that no further letter isolates, even after the free letters run out',
    names: [...Array.from('asdfghjklqwertyuiopzxcvbnm', (letter) => `tz${letter}`), 'tz'],
    typed: 't',
    expected: [...'asdfghjklqwertyuiopxcvbn'.split(''), null, null, 'm'],
  },
  {
    title: 'two-letter labels when no typed letter can split the rows',
    names: Array.from({ length: 30 }, () => 'same-name'),
    typed: 's',
    expected: ['sa', 'ss', 'sd'],
  },
])('#pickJumpLabels gives $title', (row) => {
  expect(pickJumpLabels(row.names, row.typed).slice(0, row.expected.length)).toStrictEqual([
    ...row.expected,
  ]);
});

test('#pickJumpLabels gives each of 30 rows that no letter splits its own label', () => {
  const labels = pickJumpLabels(
    Array.from({ length: 30 }, () => 'same-name'),
    's',
  );

  expect(new Set(labels).size).toBe(30);
});

test('#pickJumpLabels gives two-letter labels from a blocked letter when no letter is free', () => {
  const names = Array.from({ length: 27 }, () =>
    Array.from('asdfghjklqwertyuiopzxcvbnm', (letter) => `s${letter}`).join(''),
  );

  expect(pickJumpLabels(names, 's').slice(0, 2)).toStrictEqual(['aa', 'as']);
});
