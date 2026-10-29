import { expect, onTestFinished, test } from 'bun:test';
import type { Socket } from 'bun';
import { registerTestCleanup } from './register-test-cleanup';
import { startStubStallingProxy } from './start-stub-stalling-proxy';
import { waitFor } from './wait-for';

function setupTest() {
  const received: string[] = [];
  const accepted = Promise.withResolvers<Socket>();
  const closed = { count: 0 };
  const receivedBytes = { count: 0 };

  const target = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: (socket) => {
        accepted.resolve(socket);
      },
      data: (_socket, data) => {
        receivedBytes.count += data.byteLength;

        received.push(data.toString());
      },
      close: () => {
        closed.count += 1;
      },
    },
  });

  registerTestCleanup(() => {
    target.stop(true);
  });

  return { port: target.port, received, receivedBytes, accepted: accepted.promise, closed };
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

test('it delivers every byte to a reader too slow to take one write', async () => {
  const ctx = setupTest();
  const proxy = startStubStallingProxy(ctx.port);

  const sent = new Uint8Array(8 * 1024 * 1024).fill(0x61);

  const progress = { offset: 0 };

  const client = await Bun.connect({
    hostname: '127.0.0.1',
    port: proxy.port,
    socket: {
      data: () => {},
      drain: (socket) => {
        progress.offset += Math.max(0, socket.write(sent.subarray(progress.offset)));
      },
    },
  });

  registerTestCleanup(() => client.end());

  client.write('x');

  const peer = await ctx.accepted;

  await waitFor(() => {
    expect(ctx.received).toStrictEqual(['x']);
  });

  peer.pause();

  progress.offset += Math.max(0, client.write(sent));

  await waitFor(() => {
    expect(progress.offset).toBe(sent.byteLength);
  });

  peer.resume();

  await waitFor(() => {
    expect(ctx.receivedBytes.count).toBe(1 + sent.byteLength);
  });
});

test('it ends the upstream connection on stop after a client closed while stalled', async () => {
  const ctx = setupTest();
  const proxy = startStubStallingProxy(ctx.port);

  const client = await Bun.connect({
    hostname: '127.0.0.1',
    port: proxy.port,
    socket: { data: () => {} },
  });

  client.write('one');

  await ctx.accepted;

  await waitFor(() => {
    expect(ctx.received).toStrictEqual(['one']);
  });

  proxy.stall();
  client.end();

  await waitFor(() => {
    expect(proxy.countClosedClients()).toBe(1);
  });

  proxy.stop();

  await waitFor(() => {
    expect(ctx.closed.count).toBe(1);
  });
});

test('it resets the client connection when the target refuses its own', async () => {
  const closed = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } });
  const refusingPort = closed.port;

  closed.stop(true);

  const proxy = startStubStallingProxy(refusingPort);
  const failure = Promise.withResolvers<unknown>();

  const client = await Bun.connect({
    hostname: '127.0.0.1',
    port: proxy.port,
    socket: {
      data: () => {},
      close: (_socket, error) => {
        failure.resolve(error);
      },
    },
  });

  registerTestCleanup(() => client.end());

  expect(failure.promise).resolves.toMatchObject({ code: 'ECONNRESET' });
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
