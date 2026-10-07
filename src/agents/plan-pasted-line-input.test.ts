import { expect, test } from 'bun:test';
import { KEYS } from '../test-utils/keys';
import { planPastedLineInput } from './plan-pasted-line-input';

test('it pastes a line between bracketed paste markers and submits it in a second write', () => {
  expect(planPastedLineInput('first\nsecond', { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}first\nsecond${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it writes a line unmarked when the tui has not turned bracketed paste on', () => {
  expect(planPastedLineInput('hello', { bracketedPaste: false })).toStrictEqual([
    'hello',
    KEYS.enter,
  ]);
});

test('it drops paste markers inside the text so the text stays one paste', () => {
  expect(
    planPastedLineInput(`a${KEYS.pasteClose}${KEYS.enter}b${KEYS.pasteOpen}c`, {
      bracketedPaste: true,
    }),
  ).toStrictEqual([`${KEYS.pasteOpen}a${KEYS.enter}bc${KEYS.pasteClose}`, KEYS.enter]);
});

test('it submits empty text as a carriage return alone so the composer gains no line', () => {
  expect(planPastedLineInput('', { bracketedPaste: true })).toStrictEqual([KEYS.enter]);
});
