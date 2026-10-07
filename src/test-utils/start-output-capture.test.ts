import { expect, onTestFinished, test } from 'bun:test';
import { startOutputCapture } from './start-output-capture';
import { waitFor } from './wait-for';

test('it keeps every chunk the stream delivers, in order', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('one\n'));
      controller.enqueue(new TextEncoder().encode('two\n'));
      controller.close();
    },
  });

  const capture = startOutputCapture(stream);

  await waitFor(() => {
    expect(capture.read()).toBe('one\ntwo\n');
  });
});

test('it returns the text read so far while the stream stays open', async () => {
  const opened = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      opened.resolve(controller);
    },
  });

  const controller = await opened.promise;

  const capture = startOutputCapture(stream);

  onTestFinished(() => {
    controller.close();
  });

  controller.enqueue(new TextEncoder().encode('partial'));

  await waitFor(() => {
    expect(capture.read()).toBe('partial');
  });
});

test('it joins a character split across two chunks', async () => {
  const bytes = new TextEncoder().encode('é');

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 1));
      controller.enqueue(bytes.slice(1));
      controller.close();
    },
  });

  const capture = startOutputCapture(stream);

  await waitFor(() => {
    expect(capture.read()).toBe('é');
  });
});
