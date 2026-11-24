import invariant from 'tiny-invariant';

// A real HTTP proxy in front of a gateway. It cuts the connection of the first event stream it
// forwards right after that stream's first message, as a dropped network does, and forwards every
// other request untouched. `streamRequests` lists the Last-Event-ID of each stream request.
export function startCuttingStreamProxy(targetURL: string) {
  const streamRequests: (string | null)[] = [];

  const forwardRequest = async (request: Request): Promise<Response> => {
    const incoming = new URL(request.url);
    const target = new URL(`${incoming.pathname}${incoming.search}`, targetURL);

    // the gateway checks the Host of a request, so the proxy sends the gateway's own
    const headers = new Headers(request.headers);

    headers.set('host', target.host);

    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? await request.arrayBuffer() : null,
      signal: request.signal,
    });

    if (!incoming.pathname.endsWith('/events/stream')) {
      return response;
    }

    streamRequests.push(request.headers.get('last-event-id'));

    if (streamRequests.length > 1 || response.body === null) {
      return response;
    }

    return new Response(cutAfterFirstMessage(response.body), { headers: response.headers });
  };

  const server = Bun.serve({ port: 0, fetch: forwardRequest });

  return {
    url: `http://127.0.0.1:${server.port}`,
    streamRequests,
    stop: () => server.stop(true),
  };
}

function cutAfterFirstMessage(
  upstreamBody: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const upstream = upstreamBody.getReader();
  let isCut = false;

  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      if (isCut) {
        // a pause lets the server flush the first message before the cut, as a real drop would
        await Bun.sleep(25);
        await upstream.cancel();

        controller.error(new TypeError('the connection was cut'));

        return;
      }

      const chunk = await upstream.read();

      if (chunk.done) {
        controller.close();

        return;
      }

      const bytes: unknown = chunk.value;

      invariant(bytes instanceof Uint8Array, 'the gateway streams bytes');

      const text = new TextDecoder().decode(bytes);

      const start = text.indexOf('event: message');
      const end = text.indexOf('\n\n', start);

      if (start === -1 || end === -1) {
        controller.enqueue(bytes);

        return;
      }

      controller.enqueue(new TextEncoder().encode(text.slice(0, end + 2)));

      isCut = true;
    },
  });
}
