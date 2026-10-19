import { registerTestCleanup } from './register-test-cleanup';

export function startStubImpdInfo() {
  const paths: string[] = [];
  const info: { version: unknown } = { version: '2.2.0' };

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
    stop,
  };
}
