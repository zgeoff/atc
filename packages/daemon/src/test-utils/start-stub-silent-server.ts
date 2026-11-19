import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';

export function startStubSilentServer() {
  const paths: string[] = [];

  const answerRequest = (request: Request) => {
    paths.push(new URL(request.url).pathname);

    return new Promise<Response>(() => {});
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',

    // Bun ends a request that stays idle past its idle timeout. Setting it to 0 keeps held
    // requests open, so the stub never answers.
    idleTimeout: 0,
    fetch: answerRequest,
  });

  const stop = registerTestCleanup(() => server.stop(true));

  return {
    url: `http://127.0.0.1:${String(server.port)}/`,
    paths,
    stop,
  };
}
