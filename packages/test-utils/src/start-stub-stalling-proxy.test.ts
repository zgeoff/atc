import { expect, onTestFinished, test } from 'bun:test';
import type { Socket } from 'bun';
import { registerTestCleanup } from './register-test-cleanup';
import { startStubStallingProxy } from './start-stub-stalling-proxy';
import { waitFor } from './wait-for';

function setupTest() {
  const received: string[] = [];
  const accepted = Promise.withResolvers<Socket>();

  const target = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: (socket) => {
        accepted.resolve(socket);
      },
      data: (_socket, data) => {
        received.push(data.toString());
      },
    },
  });

  registerTestCleanup(() => {
    target.stop(true);
  });

  return { port: target.port, received, accepted: accepted.promise };
}

test('it forwards what each end sends to the other end', async () => {
  const ctx = setupTest();
  const proxy = startStubStallingProxy(ctx.port);
  const replies: string[] = [];

  const client = await Bun.connect({
    hostname: '127.0.0.1',
    port: proxy.port,
    socket: {
      data: (_socket, data) => {
        replies.push(data.toString());
      },
    },
  });

  registerTestCleanup(() => client.end());

  client.write('ping');

  const peer = await ctx.accepted;

  peer.write('pong');

  await waitFor(() => {
    expect(ctx.received).toStrictEqual(['ping']);
    expect(replies).toStrictEqual(['pong']);
  });
});

test('it drops what each end sends once it stalls', async () => {
  const ctx = setupTest();
  const proxy = startStubStallingProxy(ctx.port);
  const replies: string[] = [];

  const client = await Bun.connect({
    hostname: '127.0.0.1',
    port: proxy.port,
    socket: {
      data: (_socket, data) => {
        replies.push(data.toString());
      },
    },
  });

  registerTestCleanup(() => client.end());

  client.write('one');

  const peer = await ctx.accepted;

  await waitFor(() => {
    expect(ctx.received).toStrictEqual(['one']);
  });

  proxy.stall();
  client.write('two');
  peer.write('three');

  await waitFor(() => {
    expect(proxy.countDroppedBytes()).toBe(8);
  });

  expect(ctx.received).toStrictEqual(['one']);
  expect(replies).toBeEmpty();
});

test('it stops listening once the test finishes without a stop', () => {
  const ctx = setupTest();
  const proxy = startStubStallingProxy(ctx.port);

  onTestFinished(() => {
    expect(
      Bun.connect({ hostname: '127.0.0.1', port: proxy.port, socket: { data() {} } }),
    ).rejects.toThrow();
  });
});
