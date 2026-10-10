import { expect, test } from 'bun:test';
import { toMessageID } from '../shared/to-message-id';
import { parseNote } from './parse-note';

test('it parses a turn answer', () => {
  const note = parseNote({ kind: 'answered', message: 'm-1', answer: 'done' });

  expect(note).toStrictEqual({
    kind: 'answered',
    messages: [toMessageID('m-1')],
    answer: 'done',
    turn: null,
  });
});

test('it parses the turn a turn answer carries', () => {
  const note = parseNote({ kind: 'answered', message: 'm-1', answer: 'done', turn: 't-1' });

  expect(note).toStrictEqual({
    kind: 'answered',
    messages: [toMessageID('m-1')],
    answer: 'done',
    turn: 't-1',
  });
});

test('it parses a turn answer for every message one turn answered', () => {
  const note = parseNote({
    kind: 'answered',
    messages: ['m-1', 'm-2'],
    answer: 'both',
    turn: 't-1',
  });

  expect(note).toStrictEqual({
    kind: 'answered',
    messages: [toMessageID('m-1'), toMessageID('m-2')],
    answer: 'both',
    turn: 't-1',
  });
});

test('it rejects a turn answer holding both one message and a list', () => {
  expect(
    parseNote({ kind: 'answered', message: 'm-1', messages: ['m-2'], answer: 'x' }),
  ).toBeNull();
});

test('it rejects a turn answer with an empty message list', () => {
  expect(parseNote({ kind: 'answered', messages: [], answer: 'x' })).toBeNull();
});

test.each([[''], [42]])('it reads a turn answer turn of %p as unknown', (turn) => {
  const note = parseNote({ kind: 'answered', message: 'm-1', answer: 'done', turn });

  expect(note).toStrictEqual({
    kind: 'answered',
    messages: [toMessageID('m-1')],
    answer: 'done',
    turn: null,
  });
});

test('it rejects a note without a message id', () => {
  expect(parseNote({ kind: 'answered', answer: 'done' })).toBeNull();
});

test('it rejects an empty message id', () => {
  expect(parseNote({ kind: 'answered', message: '', answer: 'done' })).toBeNull();
});

test('it rejects an unknown note kind', () => {
  expect(parseNote({ kind: 'progress', message: 'm-1', answer: 'done' })).toBeNull();
});

test('it rejects a non-string answer', () => {
  expect(parseNote({ kind: 'answered', message: 'm-1', answer: 42 })).toBeNull();
});

test('it parses a sent note', () => {
  const note = parseNote({ kind: 'note', label: 'blocked', text: 'need review' });

  expect(note).toStrictEqual({ kind: 'note', label: 'blocked', text: 'need review' });
});

test('it rejects a note without text', () => {
  expect(parseNote({ kind: 'note', label: 'blocked', text: '' })).toBeNull();
});

test('it rejects a note with an empty label', () => {
  expect(parseNote({ kind: 'note', label: '', text: 'need review' })).toBeNull();
});

test('it rejects a note label longer than 64 characters', () => {
  expect(parseNote({ kind: 'note', label: 'x'.repeat(65), text: 'need review' })).toBeNull();
});
