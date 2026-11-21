import { expect, test } from 'bun:test';
import { pickLastLine } from './pick-last-line';

test.each([
  { title: 'the key bar with nothing to show', input: {}, expected: { kind: 'keys' } },
  {
    title: 'the prompt over everything else',
    input: {
      prompt: 'kill a? · y / n',
      filter: 'x',
      isJumpEmpty: true,
      notice: 'n',
      daemonLine: 'd',
      updateAdvice: 'u',
    },
    expected: { kind: 'prompt', text: 'kill a? · y / n' },
  },
  {
    title: 'the filter over a notice',
    input: { filter: 'ab', notice: 'n', daemonLine: 'd', updateAdvice: 'u' },
    expected: { kind: 'filter', text: 'ab' },
  },
  {
    title: 'no match of a jump that found no row',
    input: { isJumpEmpty: true, notice: 'n' },
    expected: { kind: 'text', text: 'no match' },
  },
  {
    title: 'a notice over a daemon line',
    input: { notice: 'kept shop', daemonLine: 'd', updateAdvice: 'u' },
    expected: { kind: 'text', text: 'kept shop' },
  },
  {
    title: 'a daemon line over the update advice',
    input: { daemonLine: 'lab is down', updateAdvice: 'u' },
    expected: { kind: 'text', text: 'lab is down' },
  },
  {
    title: 'the update advice alone',
    input: { updateAdvice: 'u update daemon' },
    expected: { kind: 'text', text: 'u update daemon' },
  },
])('#pickLastLine gives $title', (row) => {
  const last = pickLastLine({
    prompt: null,
    filter: null,
    isJumpEmpty: false,
    notice: null,
    daemonLine: null,
    updateAdvice: null,
    ...row.input,
  });

  expect(last).toStrictEqual(row.expected);
});
