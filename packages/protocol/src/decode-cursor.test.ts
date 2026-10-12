import { expect, test } from 'bun:test';
import { decodeCursor } from './decode-cursor';
import { encodeCursor } from './encode-cursor';

test('it decodes an events cursor it encoded', () => {
  expect(decodeCursor(encodeCursor({ kind: 'events', id: 42 }))).toStrictEqual({
    kind: 'events',
    id: 42,
  });
});

test('it decodes a transcript cursor it encoded', () => {
  const cursor = { kind: 'transcript', path: '/tmp/a b.jsonl', offset: 12 } as const;

  expect(decodeCursor(encodeCursor(cursor))).toStrictEqual(cursor);
});

test.each(['not-a-cursor', ''])('it decodes the text %p that holds no JSON to null', (raw) => {
  expect(decodeCursor(raw)).toBeNull();
});

test.each([
  '{"k":"ev","i":-1}',
  '{"k":"zz","i":42}',
  '{"k":"tr","p":"/tmp/a b.jsonl","o":-1}',
  '{"k":"tr","p":42,"o":12}',
])('it decodes the encoded wire cursor %s to null', (wire) => {
  expect(decodeCursor(Buffer.from(wire).toString('base64url'))).toBeNull();
});
