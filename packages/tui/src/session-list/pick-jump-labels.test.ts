import { expect, test } from 'bun:test';
import { pickJumpLabels } from './pick-jump-labels';
import { stepJump } from './step-jump';

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
    title: 'two-letter labels that start with a blocked letter when no letter is free',
    names: Array.from({ length: 2 }, () => 'abcdefghijklmnopqrstuvwxyz'),
    typed: '',
    expected: ['aa', 'as'],
  },
  {
    title: 'a blocked first letter only once the free first letter runs out',
    names: Array.from({ length: 27 }, () => 'sdfghjklqwertyuiopzxcvbnm'),
    typed: '',
    expected: [...Array.from('asdfghjklqwertyuiopzxcvbnm', (letter) => `a${letter}`), 'sa'],
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

test('#pickJumpLabels gives 27 rows with one free letter labels that each pick their row', () => {
  const names = Array.from({ length: 27 }, () => 'sdfghjklqwertyuiopzxcvbnm');

  const steps = pickJumpLabels(names, '').map((label) => {
    const first = label?.slice(0, 1) ?? '';
    const second = label?.slice(1, 2) ?? '';

    return [
      stepJump({ typed: '', prefix: '' }, first, names),
      stepJump({ typed: '', prefix: first }, second, names),
    ];
  });

  expect(steps).toStrictEqual(
    names.map((_name, index) => [
      { kind: 'continue', state: { typed: '', prefix: index < 26 ? 'a' : 's' } },
      { kind: 'picked', index },
    ]),
  );
});
