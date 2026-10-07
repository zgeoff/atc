import { expect, test } from 'bun:test';
import { planPastedLineInput } from '../agents/plan-pasted-line-input';
import { buildLeaderChords } from '../client/build-leader-chords';
import { KEY, planTextEdit } from '../client/keys';
import type { TextEdit } from '../client/keys';
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

test.each<[string, string, number]>([
  ['ctrlSpace', KEYS.ctrlSpace, 0],
  ['ctrlA', KEYS.ctrlA, 1],
  ['ctrlB', KEYS.ctrlB, 2],
  ['ctrlRightBracket', KEYS.ctrlRightBracket, 29],
])('it types %s as the bare leader byte the TUI listens for', (_name, key, code) => {
  expect(buildLeaderChords(code)).toContain(key);
});

test.each<[string, string, number]>([
  ['ctrlC', KEYS.ctrlC, KEY.ctrlC],
  ['tab', KEYS.tab, KEY.tab],
])('it types %s as the byte the TUI reads for it', (_name, key, byte) => {
  expect([...Buffer.from(key)]).toStrictEqual([byte]);
});

test('it wraps a paste in the markers the agent terminal reads', () => {
  expect(planPastedLineInput('hello', { bracketedPaste: true })).toStrictEqual([
    `${KEYS.pasteOpen}hello${KEYS.pasteClose}`,
    KEYS.enter,
  ]);
});

test('it holds the exact bytes of the keys no TUI reader takes', () => {
  expect({ bel: KEYS.bel, ctrlJ: KEYS.ctrlJ, right: KEYS.right, left: KEYS.left }).toStrictEqual({
    bel: '\u0007',
    ctrlJ: '\u000A',
    right: '\u001B[C',
    left: '\u001B[D',
  });
});

test.each<[string, string, TextEdit]>([
  ['esc', KEYS.esc, { kind: 'cancel' }],
  ['enter', KEYS.enter, { kind: 'submit', value: 'typed' }],
  ['backspace', KEYS.backspace, { kind: 'input', value: 'type' }],
  ['ctrlU', KEYS.ctrlU, { kind: 'input', value: '' }],
  ['up', KEYS.up, { kind: 'move', delta: -1 }],
  ['down', KEYS.down, { kind: 'move', delta: 1 }],
])('it types %s as the key a text-entry screen reads it as', (_name, key, expected) => {
  expect(
    planTextEdit(Buffer.from(key), 'typed', { isLeaderKey: () => false, moves: true }),
  ).toStrictEqual(expected);
});
