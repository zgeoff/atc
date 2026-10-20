import { expect, test } from 'bun:test';
import { planPastedLineInput } from '@atc/plugin-api';
import { KEYS } from './keys';

test('it freezes the key table', () => {
  expect(KEYS).toBeFrozen();
});

test('it holds only control bytes and sequences that open with one', () => {
  expect(Object.values(KEYS)).toSatisfyAll((key: string) => {
    const first = key.codePointAt(0) ?? 0x20;

    return first < 0x20 || first === 0x7f;
  });
});

test('it wraps a paste in the markers the agent terminal reads', () => {
  expect(planPastedLineInput('hello', { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}hello${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it holds the exact bytes of the keys no TUI reader takes', () => {
  expect(KEYS.bel).toBe('\u0007');
  expect(KEYS.ctrlJ).toBe('\u000A');
  expect(KEYS.right).toBe('\u001B[C');
  expect(KEYS.left).toBe('\u001B[D');
});
