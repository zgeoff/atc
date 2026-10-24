import { expect, test } from 'bun:test';
import { pickAccessStep } from './pick-access-step';

test.each([
  [
    'a subscription that is gone',
    { isGone: true, reads: false, isStopped: false, isRechecking: false },
    { kind: 'settle' },
  ],
  [
    'a client that reads',
    { isGone: false, reads: true, isStopped: false, isRechecking: false },
    { kind: 'send' },
  ],
  [
    'a client that reads again on the recheck',
    { isGone: false, reads: true, isStopped: false, isRechecking: true },
    { kind: 'send' },
  ],
  [
    'a client that lost read on the first check',
    { isGone: false, reads: false, isStopped: false, isRechecking: false },
    { kind: 'recheck' },
  ],
  [
    'a client that lost read on the recheck too',
    { isGone: false, reads: false, isStopped: false, isRechecking: true },
    { kind: 'cut' },
  ],
  [
    'a stopped watcher',
    { isGone: false, reads: true, isStopped: true, isRechecking: false },
    { kind: 'cut' },
  ],
] as const)('it picks the step for %s', (_label, check, expected) => {
  expect(pickAccessStep(check)).toStrictEqual(expected);
});
