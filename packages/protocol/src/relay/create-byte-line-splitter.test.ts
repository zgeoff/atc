import { expect, test } from 'bun:test';
import { createByteLineSplitter } from './create-byte-line-splitter';

test('it keeps a multi-byte character whole when a chunk cuts it in two', () => {
  const splitLines = createByteLineSplitter();

  const bytes = new TextEncoder().encode('é ok\n');

  expect([...splitLines(bytes.subarray(0, 1)), ...splitLines(bytes.subarray(1))]).toStrictEqual([
    'é ok',
  ]);
});

test('it holds a half line until its newline arrives and drops a blank line', () => {
  const splitLines = createByteLineSplitter();

  const encoder = new TextEncoder();

  expect(splitLines(encoder.encode('one\n\ntw'))).toStrictEqual(['one']);
  expect(splitLines(encoder.encode('o\n'))).toStrictEqual(['two']);
});
