import { expect, test } from 'bun:test';
import { readBoundedText } from './read-bounded-text';

test('it reads a body within the limit as its full text', async () => {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"client_id":'));
      controller.enqueue(encoder.encode('"é"}'));
      controller.close();
    },
  });

  const text = await readBoundedText(stream, 64);

  expect(text).toBe('{"client_id":"é"}');
});

test('it stops and cancels the stream once the body passes the limit', async () => {
  const cancelled: unknown[] = [];
  let pulls = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;

      controller.enqueue(new Uint8Array(4096));
    },
    cancel(reason) {
      cancelled.push(reason);
    },
  });

  const text = await readBoundedText(stream, 16_384);

  expect(text).toBeNull();
  expect(cancelled).toBeArrayOfSize(1);
  expect(pulls).toBeLessThanOrEqual(6);
});

test('it refuses a body whose limit is crossed partway through a chunk', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(10));
      controller.enqueue(new Uint8Array(10));
      controller.close();
    },
  });

  const text = await readBoundedText(stream, 15);

  expect(text).toBeNull();
});

test('it counts the limit in bytes, not characters', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('éééé'));
      controller.close();
    },
  });

  const text = await readBoundedText(stream, 4);

  expect(text).toBeNull();
});
