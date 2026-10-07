/**
 * A stand-in for better-auth's telemetry endpoint on a real HTTP port of the
 * loopback address. A process whose `BETTER_AUTH_TELEMETRY_ENDPOINT` holds
 * `url` sends its telemetry here. Every request is answered with HTTP 204,
 * and `received` holds the URL of each request, in order. Disposal stops the
 * server and resolves once it has stopped.
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

  return {
    url: `http://127.0.0.1:${String(server.port)}/`,
    received,
    [Symbol.asyncDispose]: () => server.stop(true),
  };
}
