import { expect, test } from 'bun:test';
import { matchLeaderKey } from './match-leader-key';

test.each<{ name: string; code: number; data: string; expected: 'press' | 'release' | null }>([
  { name: 'the bare control byte', code: 0, data: '\u0000', expected: 'press' },
  { name: 'the bare byte of ctrl-a', code: 1, data: '\u0001', expected: 'press' },
  { name: 'the kitty form', code: 0, data: '\u001B[32;5u', expected: 'press' },
  { name: 'the kitty form of ctrl-a', code: 1, data: '\u001B[97;5u', expected: 'press' },
  { name: 'the modifyOtherKeys form', code: 0, data: '\u001B[27;5;32~', expected: 'press' },
  { name: 'the kitty form of a repeat', code: 0, data: '\u001B[32;5:2u', expected: 'press' },
  {
    name: 'the kitty form of a press with an event type',
    code: 0,
    data: '\u001B[32;5:1u',
    expected: 'press',
  },
  { name: 'the kitty form of a release', code: 0, data: '\u001B[32;5:3u', expected: 'release' },
  {
    name: 'the kitty form with associated text',
    code: 0,
    data: '\u001B[32;5;32u',
    expected: 'press',
  },
  {
    name: 'the kitty form with alternate keys',
    code: 0,
    data: '\u001B[32:32:32;5u',
    expected: 'press',
  },
  { name: 'the kitty form with caps lock held', code: 0, data: '\u001B[32;69u', expected: 'press' },
  {
    name: 'the kitty form with num lock held',
    code: 0,
    data: '\u001B[32;133:1u',
    expected: 'press',
  },
  { name: 'a key with shift added', code: 0, data: '\u001B[32;6u', expected: null },
  { name: 'another key with ctrl', code: 0, data: '\u001B[97;5u', expected: null },
  { name: 'the space key alone', code: 0, data: '\u001B[32u', expected: null },
  { name: 'another modifyOtherKeys key', code: 0, data: '\u001B[27;5;97~', expected: null },
  { name: 'plain text', code: 0, data: 'a', expected: null },
])('#matchLeaderKey reads $name for ctrl code $code', (row) => {
  expect(matchLeaderKey(row.code, row.data)).toBe(row.expected);
});
