import { expect, test } from 'bun:test';
import { stepJump } from './step-jump';

test.each([
  {
    title: 'the one row a first letter matches, picked at once',
    state: { typed: '', prefix: '' },
    character: 'w',
    names: ['api', 'app', 'web'],
    expected: { kind: 'picked', index: 2 },
  },
  {
    title: 'a letter that matches several rows, kept as typed',
    state: { typed: '', prefix: '' },
    character: 'p',
    names: ['api', 'app', 'web'],
    expected: { kind: 'continue', state: { typed: 'p', prefix: '' } },
  },
  {
    title: 'a letter that matches no row, kept as typed',
    state: { typed: '', prefix: '' },
    character: 'q',
    names: ['api', 'app', 'web'],
    expected: { kind: 'continue', state: { typed: 'q', prefix: '' } },
  },
  {
    title: 'a label of the matched rows',
    state: { typed: 'p', prefix: '' },
    character: 's',
    names: ['api', 'app', 'web'],
    expected: { kind: 'picked', index: 1 },
  },
  {
    title: 'a second letter that leaves one row, picked at once',
    state: { typed: 'p', prefix: '' },
    character: 'i',
    names: ['api', 'apt', 'web'],
    expected: { kind: 'picked', index: 0 },
  },
  {
    title: 'the first letter of a two-letter label',
    state: { typed: 's', prefix: '' },
    character: 's',
    names: Array.from({ length: 30 }, () => 'same-name'),
    expected: { kind: 'continue', state: { typed: 's', prefix: 's' } },
  },
  {
    title: 'the second letter of a two-letter label',
    state: { typed: 's', prefix: 's' },
    character: 's',
    names: Array.from({ length: 30 }, () => 'same-name'),
    expected: { kind: 'picked', index: 1 },
  },
  {
    title: 'a second letter that no label has, which drops the first letter',
    state: { typed: 's', prefix: 's' },
    character: '9',
    names: Array.from({ length: 30 }, () => 'same-name'),
    expected: { kind: 'continue', state: { typed: 's', prefix: '' } },
  },
  {
    title: 'an uppercase letter as its lowercase letter',
    state: { typed: '', prefix: '' },
    character: 'W',
    names: ['api', 'app', 'web'],
    expected: { kind: 'picked', index: 2 },
  },
])('#stepJump gives $title', (row) => {
  expect(stepJump(row.state, row.character, row.names)).toStrictEqual(row.expected);
});
