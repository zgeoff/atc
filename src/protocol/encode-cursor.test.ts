import { expect, test } from 'bun:test';
import { encodeCursor } from './encode-cursor';

test('it encodes a cursor as url-safe text with no padding', () => {
  const encoded = encodeCursor({ kind: 'transcript', path: '/tmp/a b?.jsonl', offset: 12 });

  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
});
