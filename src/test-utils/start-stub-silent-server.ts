/**
 * An HTTP stand-in for an upstream that hangs: it listens on a real port of
 * the loopback address, takes every request, and never answers one. `paths`
 * holds the request path of each request it took, in order. Disposal stops
 * the server and drops the connections it holds; the asynchronous form
 * resolves once it has stopped.
 */
export function startStubSilentServer() {
  const paths: string[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      paths.push(new URL(request.url).pathname);

      return new Promise<Response>(() => {});
    },
  });

  return {
    url: `http://127.0.0.1:${String(server.port)}/`,
    paths,
    [Symbol.dispose]: () => {
      void server.stop(true);
    },
    [Symbol.asyncDispose]: () => server.stop(true),
  };
}
