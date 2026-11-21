import { expect, test } from 'bun:test';
import { stepJump } from './step-jump';

test.each([
  {
    title: 'a letter that is a label picks its row',
    state: { typed: '', prefix: '' },
    character: 'd',
    names: ['api', 'app', 'web'],
    expected: { kind: 'picked', index: 1 },
  },
  {
    title: 'a letter that is no label narrows the rows',
    state: { typed: '', prefix: '' },
    character: 'p',
    names: ['api', 'app', 'web'],
    expected: { kind: 'continue', state: { typed: 'p', prefix: '' } },
  },
  {
    title: 'the label of the narrowed rows, the doc example',
    state: { typed: 'p', prefix: '' },
    character: 's',
    names: ['api', 'app'],
    expected: { kind: 'picked', index: 1 },
  },
  {
    title: 'the first letter of a two-letter label',
    state: { typed: '', prefix: '' },
    character: 'a',
    names: Array.from({ length: 30 }, (_, index) => `n${index}`),
    expected: { kind: 'continue', state: { typed: '', prefix: 'a' } },
  },
  {
    title: 'the second letter of a two-letter label',
    state: { typed: '', prefix: 'a' },
    character: 's',
    names: Array.from({ length: 30 }, (_, index) => `n${index}`),
    expected: { kind: 'picked', index: 1 },
  },
  {
    title: 'a second letter that no label has drops the first letter',
    state: { typed: '', prefix: 'z' },
    character: 'z',
    names: Array.from({ length: 30 }, (_, index) => `n${index}`),
    expected: { kind: 'continue', state: { typed: '', prefix: '' } },
  },
  {
    title: 'an uppercase letter as its lowercase letter',
    state: { typed: '', prefix: '' },
    character: 'D',
    names: ['api', 'app', 'web'],
    expected: { kind: 'picked', index: 1 },
  },
])('#stepJump gives $title', (row) => {
  expect(stepJump(row.state, row.character, row.names)).toStrictEqual(row.expected);
});
