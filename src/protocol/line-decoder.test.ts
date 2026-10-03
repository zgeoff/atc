import { expect, test } from 'bun:test';
import { LineDecoder } from './line-decoder';

test('it holds a line split across chunks until its newline arrives', () => {
  const decoder = new LineDecoder();

  const first = decoder.splitText('{"id":1,');
  const second = decoder.splitText('"m":"x"}\n');

  expect({ first, second }).toStrictEqual({ first: [], second: ['{"id":1,"m":"x"}'] });
});

test('it returns every whole line of a chunk in order and keeps the unterminated tail', () => {
  const decoder = new LineDecoder();

  const lines = decoder.splitText('{"a":1}\n{"b":2}\n{"c":');

  expect({ lines, pendingLength: decoder.pendingLength }).toStrictEqual({
    lines: ['{"a":1}', '{"b":2}'],
    pendingLength: 5,
  });
});

test('it drops empty and whitespace-only lines', () => {
  const decoder = new LineDecoder();

  expect(decoder.splitText('\n  \n{"a":1}\n\t\n\n')).toStrictEqual(['{"a":1}']);
});

test('it keeps a carriage return before the newline on the line', () => {
  const decoder = new LineDecoder();

  expect(decoder.splitText('{"a":1}\r\n')).toStrictEqual(['{"a":1}\r']);
});

test('it decodes a multi-byte character split across two reads whole', () => {
  const decoder = new LineDecoder();
  const bytes = new TextEncoder().encode('{"t":"é✓"}\n');

  const first = decoder.splitChunk(bytes.subarray(0, 7));
  const second = decoder.splitChunk(bytes.subarray(7));

  expect({ first, second }).toStrictEqual({ first: [], second: ['{"t":"é✓"}'] });
});

test('it counts the buffered tail so a caller can refuse a line over its limit', () => {
  const decoder = new LineDecoder();

  decoder.splitText(`{"pad":"${'x'.repeat(1000)}`);

  expect(decoder.pendingLength).toBe(1008);
});

test('it leaves nothing buffered after a chunk that ends on a newline', () => {
  const decoder = new LineDecoder();

  decoder.splitText(`{"pad":"${'x'.repeat(1000)}"}\n`);

  expect(decoder.pendingLength).toBe(0);
});
