import { expect, test } from 'bun:test';
import {
  buildStubClock,
  registerTestCleanup,
  startStubImpd,
  startStubStallingProxy,
  waitFor,
} from '@atc/test-utils';
import { watchSocketLiveness } from './watch-socket-liveness';

function setupTest() {
  const impd = startStubImpd();
  const proxy = startStubStallingProxy(Number(new URL(impd.url).port));
  const clock = buildStubClock(0);

  return { proxy, clock };
}

test('it ends a socket that hears nothing from the far end for 30 seconds', async () => {
  const ctx = setupTest();

  const socket = watchSocketLiveness(
    new WebSocket(`ws://127.0.0.1:${String(ctx.proxy.port)}/exec`),
    ctx.clock,
  );

  registerTestCleanup(() => {
    socket.terminate();
  });

  const closes: number[] = [];

  socket.addEventListener('close', (event) => {
    closes.push(event.code);
  });

  await waitFor(() => {
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  ctx.proxy.stall();
  ctx.clock.advance(30_000);

  await waitFor(() => {
    expect(closes).toStrictEqual([1006]);
  });
});

test('it keeps a quiet socket open while the far end answers its pings', async () => {
  const ctx = setupTest();

  const socket = watchSocketLiveness(
    new WebSocket(`ws://127.0.0.1:${String(ctx.proxy.port)}/exec`),
    ctx.clock,
  );

  registerTestCleanup(() => {
    socket.terminate();
  });

  const pongs: number[] = [];

  socket.addEventListener('pong', () => {
    pongs.push(ctx.clock.now());
  });

  await waitFor(() => {
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  ctx.clock.advance(10_000);

  await waitFor(() => {
    expect(pongs).toStrictEqual([10_000]);
  });

  ctx.clock.advance(10_000);

  await waitFor(() => {
    expect(pongs).toStrictEqual([10_000, 20_000]);
  });

  ctx.clock.advance(10_000);

  await waitFor(() => {
    expect(pongs).toStrictEqual([10_000, 20_000, 30_000]);
  });

  ctx.clock.advance(10_000);

  await waitFor(() => {
    expect(pongs).toStrictEqual([10_000, 20_000, 30_000, 40_000]);
  });

  expect(socket.readyState).toBe(WebSocket.OPEN);
});

test('it stops pinging once the socket closes', async () => {
  const ctx = setupTest();

  const socket = watchSocketLiveness(
    new WebSocket(`ws://127.0.0.1:${String(ctx.proxy.port)}/exec`),
    ctx.clock,
  );

  await waitFor(() => {
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  socket.close();

  await waitFor(() => {
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  expect(ctx.clock.collectPending()).toBeEmpty();
});
