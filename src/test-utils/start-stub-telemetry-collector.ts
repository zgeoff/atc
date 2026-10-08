import { registerTestCleanup } from './register-test-cleanup';

/**
 * A stand-in for better-auth's telemetry endpoint on a real HTTP port of the
 * loopback address. A process whose `BETTER_AUTH_TELEMETRY_ENDPOINT` holds
 * `url` sends its telemetry here. Every request is answered with HTTP 204,
 * and `received` holds the URL of each request, in order. The server stops
 * once the current test finishes, so it must run inside a test; `stop`
 * stops it sooner and resolves once it has stopped, and a second stop does
 * nothing.
 */
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
