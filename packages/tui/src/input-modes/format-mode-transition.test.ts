import { expect, test } from 'bun:test';
import { NO_INPUT_MODES } from '@atc/core';
import type { InputModes } from '@atc/core';
import { formatModeTransition } from './format-mode-transition';

test.each<{
  name: string;
  from: Partial<InputModes>;
  to: Partial<InputModes>;
  kitty: boolean;
  expected: string;
}>([
  { name: 'nothing for equal modes', from: {}, to: {}, kitty: true, expected: '' },
  {
    name: 'bracketed paste on',
    from: {},
    to: { bracketedPaste: true },
    kitty: false,
    expected: '\u001B[?2004h',
  },
  {
    name: 'bracketed paste off',
    from: { bracketedPaste: true },
    to: {},
    kitty: false,
    expected: '\u001B[?2004l',
  },
  {
    name: 'application cursor keys on',
    from: {},
    to: { applicationCursorKeys: true },
    kitty: false,
    expected: '\u001B[?1h',
  },
  {
    name: 'the application keypad on',
    from: {},
    to: { applicationKeypad: true },
    kitty: false,
    expected: '\u001B=',
  },
  {
    name: 'the normal keypad back',
    from: { applicationKeypad: true },
    to: {},
    kitty: false,
    expected: '\u001B>',
  },
  {
    name: 'focus events on',
    from: {},
    to: { focusEvents: true },
    kitty: false,
    expected: '\u001B[?1004h',
  },
  {
    name: 'alternate scroll on',
    from: {},
    to: { alternateScroll: true },
    kitty: false,
    expected: '\u001B[?1007h',
  },
  {
    name: 'colour scheme updates on',
    from: {},
    to: { colourSchemeUpdates: true },
    kitty: false,
    expected: '\u001B[?2031h',
  },
  {
    name: 'drag mouse with sgr encoding on',
    from: {},
    to: { mouse: 'drag', mouseEncoding: 'sgr' },
    kitty: false,
    expected: '\u001B[?1002h\u001B[?1006h',
  },
  {
    name: 'mouse changing from click to any',
    from: { mouse: 'click' },
    to: { mouse: 'any' },
    kitty: false,
    expected: '\u001B[?1000l\u001B[?1003h',
  },
  {
    name: 'mouse changing from any to X10',
    from: { mouse: 'any' },
    to: { mouse: 'x10' },
    kitty: false,
    expected: '\u001B[?1003l\u001B[?9h',
  },
  {
    name: 'mouse off with its encoding',
    from: { mouse: 'click', mouseEncoding: 'urxvt' },
    to: {},
    kitty: false,
    expected: '\u001B[?1000l\u001B[?1015l',
  },
  {
    name: 'modifyOtherKeys 2',
    from: {},
    to: { modifyOtherKeys: 2 },
    kitty: false,
    expected: '\u001B[>4;2m',
  },
  {
    name: 'the kitty flags set, never pushed',
    from: {},
    to: { kittyStack: [1, 5] },
    kitty: true,
    expected: '\u001B[=5;1u',
  },
  {
    name: 'the kitty flags set to 0 on focus loss',
    from: { kittyStack: [5] },
    to: {},
    kitty: true,
    expected: '\u001B[=0;1u',
  },
  {
    name: 'no kitty sequence for a terminal without the protocol',
    from: {},
    to: { kittyStack: [5] },
    kitty: false,
    expected: '',
  },
])('#formatModeTransition writes $name', (row) => {
  expect(
    formatModeTransition(
      { ...NO_INPUT_MODES, ...row.from },
      { ...NO_INPUT_MODES, ...row.to },
      row.kitty,
    ),
  ).toBe(row.expected);
});
