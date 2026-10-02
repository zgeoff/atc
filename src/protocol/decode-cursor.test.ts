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

test.each([
  'not-a-cursor',
  '',
  Buffer.from('{"k":"ev","i":-1}').toString('base64url'),
  Buffer.from('{"k":"zz"}').toString('base64url'),
])('it decodes %p to null', (raw) => {
  expect(decodeCursor(raw)).toBeNull();
});
