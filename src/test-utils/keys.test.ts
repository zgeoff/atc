import { expect, test } from 'bun:test';
import { buildLeaderChords } from '../client/build-leader-chords';
import { planTextEdit } from '../client/keys';
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

test('it types Ctrl-Space as the bare leader byte the TUI listens for', () => {
  expect(buildLeaderChords(0)).toContain(KEYS.ctrlSpace);
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
