import { expect, test } from 'bun:test';
import { findLifecycleGap } from './find-lifecycle-gap.ts';

test('it finds no gap in an added, changed and exited session', () => {
  const events = [
    { ev: 'SessionAdded', state: 'running' },
    { ev: 'SessionState', state: 'needs_you' },
    { ev: 'SessionState', state: 'exited' },
  ];

  expect(findLifecycleGap(events)).toBeNull();
});

test.each([
  { missing: 'SessionAdded', events: [{ ev: 'SessionState', state: 'exited' }] },
  {
    missing: 'a state change',
    events: [
      { ev: 'SessionAdded', state: 'running' },
      { ev: 'SessionState', state: 'exited' },
    ],
  },
  {
    missing: 'the exit',
    events: [
      { ev: 'SessionAdded', state: 'running' },
      { ev: 'SessionState', state: 'needs_you' },
    ],
  },
  {
    missing: 'an exit after the state change',
    events: [
      { ev: 'SessionState', state: 'exited' },
      { ev: 'SessionAdded', state: 'running' },
      { ev: 'SessionState', state: 'running' },
    ],
  },
])('it finds a gap when the events lack $missing', (row) => {
  expect(findLifecycleGap(row.events)).toBeString();
});
