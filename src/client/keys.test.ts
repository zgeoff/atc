import { expect, test } from 'bun:test';
import { planTextEdit } from './keys';

test('it submits the whole pasted line when the paste ends in a newline', () => {
  const edit = planTextEdit(Buffer.from('fleettest\r'), '', {
    isLeaderKey: () => false,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'submit', value: 'fleettest' });
});

test('it submits the text already typed when enter arrives alone', () => {
  const edit = planTextEdit(Buffer.from('\r'), 'fleettest', {
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
  const edit = planTextEdit(Buffer.from('\u001B'), 'typed', {
    isLeaderKey: () => false,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'cancel' });
});

test('it reports the leader key ahead of any text it could be', () => {
  const edit = planTextEdit(Buffer.from('\u0000'), 'typed', {
    isLeaderKey: (buf) => buf[0] === 0x00,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'leader' });
});

test('it drops the last character on backspace', () => {
  const edit = planTextEdit(Buffer.from('\u007F'), 'typed', {
    isLeaderKey: () => false,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'input', value: 'type' });
});

test('it clears the whole line on ctrl-u', () => {
  const edit = planTextEdit(Buffer.from('\u0015'), 'typed', {
    isLeaderKey: () => false,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'input', value: '' });
});

test('it moves the selection down on an arrow when the screen has a list', () => {
  const edit = planTextEdit(Buffer.from('\u001B[B'), '', {
    isLeaderKey: () => false,
    moves: true,
  });

  expect(edit).toStrictEqual({ kind: 'move', delta: 1 });
});

test('it ignores an arrow on a screen without a list', () => {
  const edit = planTextEdit(Buffer.from('\u001B[A'), '', {
    isLeaderKey: () => false,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'none' });
});

test('it ignores a chunk that carries no printable character', () => {
  const edit = planTextEdit(Buffer.from('\u0001\u0002'), 'typed', {
    isLeaderKey: () => false,
    moves: false,
  });

  expect(edit).toStrictEqual({ kind: 'none' });
});
