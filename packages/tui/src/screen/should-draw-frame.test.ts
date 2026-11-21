import { expect, test } from 'bun:test';
import { shouldDrawFrame } from './should-draw-frame';

test.each([
  {
    name: 'draws once the session output is parsed',
    state: {
      isScreenWriting: false,
      isStreamSettled: true,
      isReplaying: false,
      waitingSinceMs: null,
    },
    expected: true,
  },
  {
    name: 'waits for session output that just arrived',
    state: {
      isScreenWriting: false,
      isStreamSettled: false,
      isReplaying: false,
      waitingSinceMs: null,
    },
    expected: false,
  },
  {
    name: 'waits less than a frame for session output',
    state: {
      isScreenWriting: false,
      isStreamSettled: false,
      isReplaying: false,
      waitingSinceMs: 990,
    },
    expected: false,
  },
  {
    name: 'draws after a frame of waiting for session output',
    state: {
      isScreenWriting: false,
      isStreamSettled: false,
      isReplaying: false,
      waitingSinceMs: 984,
    },
    expected: true,
  },
  {
    name: 'never draws a replay that is still arriving',
    state: { isScreenWriting: false, isStreamSettled: false, isReplaying: true, waitingSinceMs: 0 },
    expected: false,
  },
  {
    name: 'waits for a screen that still writes',
    state: { isScreenWriting: true, isStreamSettled: true, isReplaying: false, waitingSinceMs: 0 },
    expected: false,
  },
])('#shouldDrawFrame $name', (row) => {
  expect(shouldDrawFrame({ ...row.state, nowMs: 1000 })).toBe(row.expected);
});
