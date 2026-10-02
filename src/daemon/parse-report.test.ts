import { expect, test } from 'bun:test';
import { toMessageID } from '../shared/to-message-id';
import { parseReport } from './parse-report';

test('it parses an answered report', () => {
  const report = parseReport({ kind: 'answered', message: 'm-1', answer: 'done' });

  expect(report).toStrictEqual({ kind: 'answered', message: toMessageID('m-1'), answer: 'done' });
});

test('it rejects a report without a message id', () => {
  expect(parseReport({ kind: 'answered', answer: 'done' })).toBeNull();
});

test('it rejects an empty message id', () => {
  expect(parseReport({ kind: 'answered', message: '', answer: 'done' })).toBeNull();
});

test('it rejects an unknown report kind', () => {
  expect(parseReport({ kind: 'progress', message: 'm-1', answer: 'done' })).toBeNull();
});

test('it rejects a non-string answer', () => {
  expect(parseReport({ kind: 'answered', message: 'm-1', answer: 42 })).toBeNull();
});

test('it parses a note report', () => {
  const report = parseReport({ kind: 'note', label: 'blocked', text: 'need review' });

  expect(report).toStrictEqual({ kind: 'note', label: 'blocked', text: 'need review' });
});

test('it rejects a note without text', () => {
  expect(parseReport({ kind: 'note', label: 'blocked', text: '' })).toBeNull();
});

test('it rejects a note with an empty label', () => {
  expect(parseReport({ kind: 'note', label: '', text: 'need review' })).toBeNull();
});

test('it rejects a note label longer than 64 characters', () => {
  expect(parseReport({ kind: 'note', label: 'x'.repeat(65), text: 'need review' })).toBeNull();
});
