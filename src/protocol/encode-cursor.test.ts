import { expect, test } from 'bun:test';
import { encodeCursor } from './encode-cursor';

test('it encodes a transcript cursor as its golden wire text', () => {
  expect(
    encodeCursor({ kind: 'transcript', path: '/tmp/a b?.jsonl', offset: 12 }),
  ).toMatchInlineSnapshot(`"eyJrIjoidHIiLCJwIjoiL3RtcC9hIGI_Lmpzb25sIiwibyI6MTJ9"`);
});

test('it encodes an events cursor as its golden wire text', () => {
  expect(encodeCursor({ kind: 'events', id: 42 })).toMatchInlineSnapshot(
    `"eyJrIjoiZXYiLCJpIjo0Mn0"`,
  );
});

test('it encodes the same cursor to the same text every time', () => {
  expect(encodeCursor({ kind: 'transcript', path: '/tmp/a b?.jsonl', offset: 12 })).toStrictEqual(
    encodeCursor({ kind: 'transcript', path: '/tmp/a b?.jsonl', offset: 12 }),
  );
});

test('it encodes a cursor as url-safe text with no padding', () => {
  const encoded = encodeCursor({ kind: 'transcript', path: '/tmp/a b?.jsonl', offset: 12 });

  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
});
