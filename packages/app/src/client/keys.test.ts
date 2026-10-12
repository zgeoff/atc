import { expect, test } from 'bun:test';
import { KEYS } from '../test-utils/keys';
import { planTextEdit } from './keys';

test('it submits the whole pasted line when the paste ends in a newline', () => {
  const edit = planTextEdit(Buffer.from(`fleettest${KEYS.enter}`), '', {
    isLeaderKey: () => false,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'submit', value: 'fleettest' });
});

test('it submits the text already typed when enter arrives alone', () => {
  const edit = planTextEdit(Buffer.from(KEYS.enter), 'fleettest', {
    isLeaderKey: () => false,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'submit', value: 'fleettest' });
});

test('it appends a paste that carries no newline', () => {
  const edit = planTextEdit(Buffer.from('two words'), 'one ', {
    isLeaderKey: () => false,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'input', value: 'one two words' });
});

test('it cancels on a bare escape', () => {
  const edit = planTextEdit(Buffer.from(KEYS.esc), 'typed', {
    isLeaderKey: () => false,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'cancel' });
});

test('it reports the leader key ahead of any text it could be', () => {
  const edit = planTextEdit(Buffer.from(KEYS.ctrlSpace), 'typed', {
    isLeaderKey: (buf) => buf.toString() === KEYS.ctrlSpace,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'leader' });
});

test('it drops the last character on backspace', () => {
  const edit = planTextEdit(Buffer.from(KEYS.backspace), 'typed', {
    isLeaderKey: () => false,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'input', value: 'type' });
});

test('it clears the whole line on ctrl-u', () => {
  const edit = planTextEdit(Buffer.from(KEYS.ctrlU), 'typed', {
    isLeaderKey: () => false,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'input', value: '' });
});

test('it moves the selection down on an arrow when the screen has a list', () => {
  const edit = planTextEdit(Buffer.from(KEYS.down), '', {
    isLeaderKey: () => false,
    moves: true,
  });

  expect(edit).toStrictEqual({ kind: 'move', delta: 1 });
});

test('it ignores an arrow on a screen without a list', () => {
  const edit = planTextEdit(Buffer.from(KEYS.up), '', {
    isLeaderKey: () => false,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'none' });
});

test('it ignores a chunk that carries no printable character', () => {
  const edit = planTextEdit(Buffer.from(`${KEYS.ctrlA}${KEYS.ctrlB}`), 'typed', {
    isLeaderKey: () => false,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'none' });
});
