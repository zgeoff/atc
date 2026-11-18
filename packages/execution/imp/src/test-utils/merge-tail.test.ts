import { expect, test } from 'bun:test';
import { mergeTail } from './merge-tail';

test('it appends the data to the ring while both fit the limit', () => {
  expect(mergeTail(Uint8Array.of(1, 2), Uint8Array.of(3), 3)).toStrictEqual(Uint8Array.of(1, 2, 3));
});

test('it keeps the last bytes when the join passes the limit', () => {
  expect(mergeTail(Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5), 3)).toStrictEqual(
    Uint8Array.of(3, 4, 5),
  );
});

test('it keeps every byte when the limit is infinite', () => {
  expect(mergeTail(Uint8Array.of(1), Uint8Array.of(2), Number.POSITIVE_INFINITY)).toStrictEqual(
    Uint8Array.of(1, 2),
  );
});

test('it leaves the ring it was given unchanged', () => {
  const ring = Uint8Array.of(1, 2);

  mergeTail(ring, Uint8Array.of(3), 2);

  expect(ring).toStrictEqual(Uint8Array.of(1, 2));
});
