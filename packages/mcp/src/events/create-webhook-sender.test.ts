import { expect, mock, onTestFinished, test } from 'bun:test';
import { createWebhookSender } from './create-webhook-sender';

// A receiver on this machine, which a callback must never reach.
function setupTest() {
  const received = mock(() => new Response('{}'));
  const receiver = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: received });

  onTestFinished(() => receiver.stop(true));

  return { received, port: receiver.port };
}

test('it refuses a host that resolves to a loopback address without connecting', async () => {
  const ctx = setupTest();
  const send = createWebhookSender({ resolveHost: () => Promise.resolve(['127.0.0.1']) });

  const outcome = await send({
    url: `https://hooks.example.com:${ctx.port}/hook`,
    headers: {},
    body: '{}',
  });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
  expect(ctx.received).not.toHaveBeenCalled();
});

test('it refuses a host when any of its addresses is private', async () => {
  const send = createWebhookSender({
    resolveHost: () => Promise.resolve(['93.184.215.14', '10.0.0.8']),
  });

  const outcome = await send({ url: 'https://hooks.example.com/hook', headers: {}, body: '{}' });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
});

test('it refuses a callback written as a loopback address without resolving it', async () => {
  const ctx = setupTest();
  const resolveHost = mock(() => Promise.resolve(['93.184.215.14']));
  const send = createWebhookSender({ resolveHost });

  const outcome = await send({
    url: `https://127.0.0.1:${ctx.port}/hook`,
    headers: {},
    body: '{}',
  });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
  expect(resolveHost).not.toHaveBeenCalled();
});

test('it refuses a plain http callback', async () => {
  const ctx = setupTest();
  const send = createWebhookSender({ resolveHost: () => Promise.resolve(['93.184.215.14']) });

  const outcome = await send({
    url: `http://hooks.example.com:${ctx.port}/hook`,
    headers: {},
    body: '{}',
  });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
});

test('it reports a host that does not resolve as refused', async () => {
  const send = createWebhookSender({
    resolveHost: () => Promise.reject(new Error('getaddrinfo ENOTFOUND hooks.example.com')),
  });

  const outcome = await send({ url: 'https://hooks.example.com/hook', headers: {}, body: '{}' });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
});
