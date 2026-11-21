import { expect, test } from 'bun:test';
import { createInputModeTracker } from './create-input-mode-tracker';
import type { InputModes } from './create-input-mode-tracker';

test.each<{ name: string; writes: string[]; expected: Partial<InputModes> }>([
  { name: 'nothing', writes: [], expected: {} },
  { name: 'DECCKM on', writes: ['\u001B[?1h'], expected: { applicationCursorKeys: true } },
  { name: 'DECCKM on then off', writes: ['\u001B[?1h\u001B[?1l'], expected: {} },
  { name: 'keypad on', writes: ['\u001B='], expected: { applicationKeypad: true } },
  { name: 'keypad on then off', writes: ['\u001B=\u001B>'], expected: {} },
  { name: 'mouse click', writes: ['\u001B[?1000h'], expected: { mouse: 'click' } },
  { name: 'mouse drag', writes: ['\u001B[?1002h'], expected: { mouse: 'drag' } },
  {
    name: 'mouse any beats drag',
    writes: ['\u001B[?1002h\u001B[?1003h'],
    expected: { mouse: 'any' },
  },
  {
    name: 'mouse any off leaves drag',
    writes: ['\u001B[?1002;1003h\u001B[?1003l'],
    expected: { mouse: 'drag' },
  },
  { name: 'sgr encoding', writes: ['\u001B[?1006h'], expected: { mouseEncoding: 'sgr' } },
  { name: 'urxvt encoding', writes: ['\u001B[?1015h'], expected: { mouseEncoding: 'urxvt' } },
  { name: 'sgr beats urxvt', writes: ['\u001B[?1015;1006h'], expected: { mouseEncoding: 'sgr' } },
  { name: 'alternate scroll', writes: ['\u001B[?1007h'], expected: { alternateScroll: true } },
  { name: 'bracketed paste', writes: ['\u001B[?2004h'], expected: { bracketedPaste: true } },
  { name: 'focus events', writes: ['\u001B[?1004h'], expected: { focusEvents: true } },
  {
    name: 'colour scheme updates',
    writes: ['\u001B[?2031h'],
    expected: { colourSchemeUpdates: true },
  },
  { name: 'kitty push', writes: ['\u001B[>1u\u001B[>5u'], expected: { kittyStack: [1, 5] } },
  { name: 'kitty push without flags', writes: ['\u001B[>u'], expected: { kittyStack: [0] } },
  { name: 'kitty pop', writes: ['\u001B[>1u\u001B[>5u\u001B[<u'], expected: { kittyStack: [1] } },
  {
    name: 'kitty pop count',
    writes: ['\u001B[>1u\u001B[>5u\u001B[>7u\u001B[<2u'],
    expected: { kittyStack: [1] },
  },
  { name: 'kitty pop past the bottom', writes: ['\u001B[>1u\u001B[<9u'], expected: {} },
  { name: 'kitty set replaces', writes: ['\u001B[>1u\u001B[=4;1u'], expected: { kittyStack: [4] } },
  {
    name: 'kitty set adds bits',
    writes: ['\u001B[>1u\u001B[=4;2u'],
    expected: { kittyStack: [5] },
  },
  {
    name: 'kitty set clears bits',
    writes: ['\u001B[>5u\u001B[=1;3u'],
    expected: { kittyStack: [4] },
  },
  { name: 'kitty query changes nothing', writes: ['\u001B[?u'], expected: {} },
  { name: 'modifyOtherKeys 2', writes: ['\u001B[>4;2m'], expected: { modifyOtherKeys: 2 } },
  { name: 'modifyOtherKeys reset', writes: ['\u001B[>4;2m\u001B[>4;0m'], expected: {} },
  {
    name: 'a sequence split across writes',
    writes: ['\u001B[?20', '04h\u001B', '[>3', 'u'],
    expected: { bracketedPaste: true, kittyStack: [3] },
  },
  {
    name: 'a sequence split after the escape',
    writes: ['\u001B', '='],
    expected: { applicationKeypad: true },
  },
  {
    name: 'text between sequences',
    writes: ['hi\u001B[?1hthere'],
    expected: { applicationCursorKeys: true },
  },
  { name: 'a sequence inside an OSC string', writes: ['\u001B]0;\u001B[?1h\u0007'], expected: {} },
  { name: 'full reset', writes: ['\u001B[?1h\u001B[>3u\u001Bc'], expected: {} },
  { name: 'a charset designator is not the keypad', writes: ['\u001B(='], expected: {} },
  { name: 'colon sub-parameters', writes: ['\u001B[?2004:1h'], expected: { bracketedPaste: true } },
])('#write tracks $name', (row) => {
  const expected = row.expected;
  const tracker = createInputModeTracker();

  for (const data of row.writes) {
    tracker.write(data);
  }

  expect(tracker.read()).toStrictEqual({
    mouse: 'off',
    mouseEncoding: 'default',
    alternateScroll: false,
    bracketedPaste: false,
    focusEvents: false,
    applicationCursorKeys: false,
    applicationKeypad: false,
    kittyStack: [],
    modifyOtherKeys: 0,
    colourSchemeUpdates: false,
    ...expected,
  });
});

test('#write drops the oldest kitty entry past 16', () => {
  const tracker = createInputModeTracker();

  tracker.write(Array.from({ length: 17 }, (_, index) => `\u001B[>${index}u`).join(''));

  expect(tracker.read().kittyStack).toStrictEqual(
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
});

test('#reset returns every mode to its default', () => {
  const tracker = createInputModeTracker();

  tracker.write('\u001B[?1000h\u001B[>3u');
  tracker.reset();

  expect(tracker.read().kittyStack).toStrictEqual([]);
  expect(tracker.read().mouse).toBe('off');
});
