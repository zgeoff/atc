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
