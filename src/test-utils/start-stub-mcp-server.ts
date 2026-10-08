import { registerTestCleanup } from './register-test-cleanup';

interface StubMCPRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly type: string | null;
  readonly body: unknown;
}

interface StubMCPServer {
  readonly url: string;

  // Every request the stand-in received, in arrival order.
  readonly requests: readonly StubMCPRequest[];

  readonly [Symbol.dispose]: () => void;
}

/**
 * A stand-in for an MCP HTTP server on a loopback port: it answers every
 * request with the JSON body given, and records each request's method,
 * path, authorization and content-type headers, and JSON body. `url` holds
 * its origin. It stops once the current test finishes, so it must run
 * inside a test; disposal stops it sooner, and a second stop does nothing.
 */
export function startStubMCPServer(answer: unknown): StubMCPServer {
  const requests: StubMCPRequest[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        type: request.headers.get('content-type'),
        body: await request.json(),
      });

      return Response.json(answer);
    },
  });

  const stop = registerTestCleanup(() => server.stop(true));

  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    requests,
    [Symbol.dispose]: () => {
      void stop();
    },
  };
}
