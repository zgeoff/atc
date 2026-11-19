import { expect, test } from 'bun:test';
import { encodeCursor } from './encode-cursor';

test('it encodes a transcript cursor as its golden wire text', () => {
  expect(
    encodeCursor({ kind: 'transcript', path: '/tmp/a b?.jsonl', offset: 12 }),
  ).toMatchInlineSnapshot(`"WyJ0cmFuc2NyaXB0IiwiL3RtcC9hIGI_Lmpzb25sIiwxMl0"`);
});

test('it encodes an events cursor as its golden wire text', () => {
  expect(encodeCursor({ kind: 'events', id: 42 })).toMatchInlineSnapshot(`"WyJldmVudHMiLDQyXQ"`);
});

test('it encodes the same cursor to the same text every time', () => {
  expect(encodeCursor({ kind: 'transcript', path: '/tmp/a b?.jsonl', offset: 12 })).toStrictEqual(
    encodeCursor({ kind: 'transcript', path: '/tmp/a b?.jsonl', offset: 12 }),
  );
});

test('it encodes a cursor as url-safe text with no padding', () => {
  const encoded = encodeCursor({ kind: 'transcript', path: '/tmp/a b?.jsonl', offset: 12 });

  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
});
