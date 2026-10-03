import { expect, test } from 'bun:test';
import { planPastedLineInput } from './plan-pasted-line-input';

test('it pastes a line between bracketed paste markers and submits it in a second write', () => {
  expect(planPastedLineInput('first\nsecond', { bracketedPaste: true })).toStrictEqual([
    '\u001B[200~first\nsecond\u001B[201~',
    '\r',
  ]);
});

test('it writes a line unmarked when the tui has not turned bracketed paste on', () => {
  expect(planPastedLineInput('hello', { bracketedPaste: false })).toStrictEqual(['hello', '\r']);
});

test('it drops paste markers inside the text so the text stays one paste', () => {
  expect(
    planPastedLineInput('a\u001B[201~\rb\u001B[200~c', { bracketedPaste: true }),
  ).toStrictEqual(['\u001B[200~a\rbc\u001B[201~', '\r']);
});
