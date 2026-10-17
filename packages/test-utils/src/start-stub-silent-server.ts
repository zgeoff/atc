import { registerTestCleanup } from './register-test-cleanup';

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
