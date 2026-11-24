interface StubStreamMessage {
  readonly id: string;
  readonly data: unknown;
}

// An oRPC event stream response that sends each message with its event id and a 1 ms retry, then
// either ends the stream or drops it as a cut connection does.
export function buildStubEventStream(
  messages: readonly StubStreamMessage[],
  ending: 'end' | 'drop',
): Response {
  const encoder = new TextEncoder();

  const text = messages
    .map(
      (message) =>
        `event: message\ndata: ${JSON.stringify({ json: message.data })}\nid: ${message.id}\nretry: 1\n\n`,
    )
    .join('');

  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(encoder.encode(text));

      if (ending === 'end') {
        controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'));
        controller.close();
      }
    },
    pull: (controller) => {
      if (ending === 'drop') {
        controller.error(new TypeError('the connection was cut'));
      }
    },
  });

  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}
