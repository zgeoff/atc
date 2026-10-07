import { expect, onTestFinished, test } from 'bun:test';
import { startStubSilentServer } from './start-stub-silent-server';
import { waitFor } from './wait-for';

test('it takes a request and never answers it', async () => {
  await using server = startStubSilentServer();

  const controller = new AbortController();

  onTestFinished(() => {
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
  await using server = startStubSilentServer();

  const controller = new AbortController();

  onTestFinished(() => {
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

test('it stops listening once disposed', async () => {
  const server = startStubSilentServer();

  await server[Symbol.asyncDispose]();

  expect(fetch(`${server.url}silent.git`)).rejects.toThrow();
});
