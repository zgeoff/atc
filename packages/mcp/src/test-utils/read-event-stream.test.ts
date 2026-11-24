import { expect, test } from 'bun:test';
import { readEventStream } from './read-event-stream';

test('it reads messages with their event, id and data, and counts the comments before them', async () => {
  const text =
    ': \n\nevent: message\nid: g1.a\ndata: {"json":1}\n\n: keep\n\nevent: done\ndata: {"json":2}\n\n';

  const read = await readEventStream(new Response(text), { messages: 2 });

  expect(read).toStrictEqual({
    messages: [
      { event: 'message', id: 'g1.a', data: { json: 1 } },
      { event: 'done', id: null, data: { json: 2 } },
    ],
    comments: 2,
  });
});

test('it reads no message from a response with no body', async () => {
  const read = await readEventStream(new Response(null), { messages: 1 });

  expect(read).toStrictEqual({ messages: [], comments: 0 });
});

test('it stops at the comments asked for when no message comes', async () => {
  const read = await readEventStream(new Response(': \n\n: \n\n'), { comments: 2 });

  expect(read).toStrictEqual({ messages: [], comments: 2 });
});
