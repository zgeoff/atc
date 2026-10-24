import { expect, test } from 'bun:test';
import { pickEventStep } from './pick-event-step';

test.each([
  ['a gone subscription', { isGone: true, isStopped: false, reads: true, isMatch: true }, 'stop'],
  ['a stopped watcher', { isGone: false, isStopped: true, reads: true, isMatch: true }, 'stop'],
  [
    'a client without read',
    { isGone: false, isStopped: false, reads: false, isMatch: true },
    'stop',
  ],
  ['a matching event', { isGone: false, isStopped: false, reads: true, isMatch: true }, 'deliver'],
  [
    'an event of another type',
    { isGone: false, isStopped: false, reads: true, isMatch: false },
    'skip',
  ],
] as const)('it picks the step for %s', (_label, observed, kind) => {
  expect(pickEventStep(observed)).toStrictEqual({ kind });
});
