import { expect, test } from 'bun:test';
import { parseMatchingLines } from './parse-matching-lines';

test('it parses each line grep printed', () => {
  expect(parseMatchingLines('first\nsecond\n', 0)).toStrictEqual(['first', 'second']);
});

test('it parses a last line with no newline', () => {
  expect(parseMatchingLines('first\nsecond', 0)).toStrictEqual(['first', 'second']);
});

test('it parses the exit of a grep that matched no line as no lines', () => {
  expect(parseMatchingLines('', 1)).toStrictEqual([]);
});

test('it parses the exit of a grep that could not read the file as no read', () => {
  expect(parseMatchingLines('', 2)).toBeNull();
});
