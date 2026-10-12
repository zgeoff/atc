import { expect, onTestFinished, test } from 'bun:test';
import { registerTestCleanup } from './register-test-cleanup';
import { startStubSilentServer } from './start-stub-silent-server';
import { waitFor } from './wait-for';

test('it takes a request and never answers it', async () => {
  const server = startStubSilentServer();

  const controller = new AbortController();

  registerTestCleanup(() => {
    controller.abort();
  });

  const response = fetch(`${server.url}silent.git`, { signal: controller.signal });

  await waitFor(() => {
    expect(server.paths).toStrictEqual(['/silent.git']);
  });

  controller.abort();

  expect(response).rejects.toMatchObject({ name: 'AbortError' });
});

test('it records the path of each request in order', async () => {
  const server = startStubSilentServer();

  const controller = new AbortController();

  registerTestCleanup(() => {
    controller.abort();
  });

  const first = fetch(`${server.url}first`, { signal: controller.signal });

  // The abort at the end rejects the request; nothing awaits it.
  void Promise.allSettled([first]);

  await waitFor(() => {
    expect(server.paths).toStrictEqual(['/first']);
  });

  const second = fetch(`${server.url}second`, { signal: controller.signal });

  // The abort at the end rejects the request; nothing awaits it.
  void Promise.allSettled([second]);

  await waitFor(() => {
    expect(server.paths).toStrictEqual(['/first', '/second']);
  });
});

test('it stops listening once stopped', async () => {
  const server = startStubSilentServer();

  await server.stop();

  expect(fetch(`${server.url}silent.git`)).rejects.toThrow();
});

test('it stops listening once the test finishes without a stop', () => {
  const server = startStubSilentServer();
  const port = Number(new URL(server.url).port);

  onTestFinished(() => {
    expect(Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } })).rejects.toThrow();
  });
});
