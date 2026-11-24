import { expect, test } from 'bun:test';
import { buildStubEventStream } from './build-stub-event-stream';

test('it sends each message with its id and then ends the stream', async () => {
  const response = buildStubEventStream([{ id: 'g1.a', data: { seq: 1 } }], 'end');

  const text = await response.text();

  expect(text).toBe(
    'event: message\ndata: {"json":{"seq":1}}\nid: g1.a\nretry: 1\n\nevent: done\ndata: {}\n\n',
  );
});

test('it errors the stream after its messages when it drops', async () => {
  const response = buildStubEventStream([{ id: 'g1.a', data: {} }], 'drop');
  const reader = response.body?.getReader();

  const first = await reader?.read();

  const bytes: unknown = first?.value;
  const text = bytes instanceof Uint8Array ? new TextDecoder().decode(bytes) : '';

  expect(text).toContain('id: g1.a');
  expect(reader?.read()).rejects.toThrow('the connection was cut');
});
