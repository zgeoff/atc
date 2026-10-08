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

test('it types a slash command name and pastes its argument so the command runs at any length', () => {
  const argument = 'a'.repeat(2000);

  expect(planPastedLineInput(`/goal ${argument}`, { bracketedPaste: true })).toStrictEqual([
    '/goal ',
    `${KEYS.pasteOpen}${argument}${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it types a namespaced slash command name with every space that follows it', () => {
  expect(
    planPastedLineInput('/plugin:do-it_2  first\nsecond', { bracketedPaste: true }),
  ).toStrictEqual([
    '/plugin:do-it_2  ',
    `${KEYS.pasteOpen}first\nsecond${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it pastes a slash command without an argument whole', () => {
  expect(planPastedLineInput('/clear', { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}/clear${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it pastes a slash command whose argument is only spaces whole', () => {
  expect(planPastedLineInput('/clear  ', { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}/clear  ${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it pastes a slash command whose argument starts on the next line whole', () => {
  expect(planPastedLineInput('/goal\nfinish', { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}/goal\nfinish${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it pastes a line that starts with a path whole', () => {
  expect(planPastedLineInput('/tmp/out holds the log', { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}/tmp/out holds the log${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it pastes a line whose slash comes after leading text whole', () => {
  expect(planPastedLineInput(' /goal finish', { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen} /goal finish${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it drops paste markers from a slash command line before it splits the line', () => {
  expect(
    planPastedLineInput(`/go${KEYS.pasteOpen}al a${KEYS.pasteClose}b`, { bracketedPaste: true }),
  ).toStrictEqual(['/goal ', `${KEYS.pasteOpen}ab${KEYS.pasteClose}`, KEYS.enter]);
});

test('it writes a slash command line unmarked when the tui has not turned bracketed paste on', () => {
  expect(planPastedLineInput('/goal finish', { bracketedPaste: false })).toStrictEqual([
    '/goal finish',
    KEYS.enter,
  ]);
});
