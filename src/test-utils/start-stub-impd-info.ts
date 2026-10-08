import { registerTestCleanup } from './register-test-cleanup';

/**
 * An impd stand-in on a real HTTP port of the loopback address. Every call
 * is answered with HTTP 200 and the body impd's RPC sends for system info,
 * `{ json: info }`, so a client reads `info.features` as impd's features;
 * the test sets `info.features` to what impd should report. `paths` holds
 * the request path of each call, in order. The server stops once the
 * current test finishes, so it must run inside a test; disposal stops it
 * sooner, the asynchronous form resolving once it has stopped, and a second
 * stop does nothing.
 */
export function startStubImpdInfo() {
  const paths: string[] = [];
  const info: { features: unknown } = { features: undefined };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      paths.push(new URL(request.url).pathname);

      return Response.json({ json: info });
    },
  });

  const stop = registerTestCleanup(() => server.stop(true));

  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    paths,
    info,
    [Symbol.dispose]: () => {
      void stop();
    },
    [Symbol.asyncDispose]: stop,
  };
}
