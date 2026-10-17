import { registerTestCleanup } from './register-test-cleanup';

export function startStubTelemetryCollector() {
  const received: string[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      received.push(request.url);

      return new Response(null, { status: 204 });
    },
  });

  const stop = registerTestCleanup(() => server.stop(true));

  return {
    url: `http://127.0.0.1:${String(server.port)}/`,
    received,
    stop,
  };
}
