import { registerTestCleanup } from './register-test-cleanup';

/**
 * An HTTP stand-in for an upstream that hangs: it listens on a real port of
 * the loopback address, takes every request, and never answers one. `paths`
 * holds the request path of each request it took, in order. The server
 * stops, dropping the connections it holds, once the current test finishes,
 * so it must run inside a test; `stop` stops it sooner and resolves once it
 * has stopped, and a second stop does nothing.
 */
export function startStubSilentServer() {
  const paths: string[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',

    // A held request would otherwise end after Bun's idle timeout, and the
    // upstream would stop being one that never answers.
    idleTimeout: 0,
    fetch: (request) => {
      paths.push(new URL(request.url).pathname);

      return new Promise<Response>(() => {});
    },
  });

  const stop = registerTestCleanup(() => server.stop(true));

  return {
    url: `http://127.0.0.1:${String(server.port)}/`,
    paths,
    stop,
  };
}
