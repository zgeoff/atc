import { expect, mock, test } from 'bun:test';
import { createWebhookSender } from './create-webhook-sender';

// A transport that records each request it is asked to post, and answers 204.
function setupTest() {
  const transport = mock<(target: string, init: BunFetchRequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(null, { status: 204 })),
  );

  return { transport };
}

test('it posts the request to the checked address through the transport it is given', async () => {
  const ctx = setupTest();

  const send = createWebhookSender({
    resolveHost: () => Promise.resolve(['93.184.215.14']),
    transport: ctx.transport,
  });

  const outcome = await send({
    url: 'https://hooks.example.com:8443/hook?team=7',
    headers: { 'webhook-id': 'msg_1' },
    body: '{"name":"session.turn_done"}',
  });

  expect(outcome).toStrictEqual({ kind: 'answered', status: 204, body: '' });

  expect(ctx.transport).toHaveBeenCalledExactlyOnceWith(
    'https://93.184.215.14:8443/hook?team=7',
    expect.objectContaining({
      method: 'POST',
      body: '{"name":"session.turn_done"}',
      redirect: 'manual',
    }),
  );
});

test('it refuses a host that resolves to a loopback address without connecting', async () => {
  const ctx = setupTest();

  const send = createWebhookSender({
    resolveHost: () => Promise.resolve(['127.0.0.1']),
    transport: ctx.transport,
  });

  const outcome = await send({ url: 'https://hooks.example.com/hook', headers: {}, body: '{}' });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
  expect(ctx.transport).not.toHaveBeenCalled();
});

test('it refuses a host when any of its addresses is private', async () => {
  const ctx = setupTest();

  const send = createWebhookSender({
    resolveHost: () => Promise.resolve(['93.184.215.14', '10.0.0.8']),
    transport: ctx.transport,
  });

  const outcome = await send({ url: 'https://hooks.example.com/hook', headers: {}, body: '{}' });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
  expect(ctx.transport).not.toHaveBeenCalled();
});

test('it refuses a callback written as a loopback address without resolving it', async () => {
  const ctx = setupTest();
  const resolveHost = mock(() => Promise.resolve(['93.184.215.14']));
  const send = createWebhookSender({ resolveHost, transport: ctx.transport });

  const outcome = await send({ url: 'https://127.0.0.1:8443/hook', headers: {}, body: '{}' });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
  expect(resolveHost).not.toHaveBeenCalled();
  expect(ctx.transport).not.toHaveBeenCalled();
});

test('it refuses a plain http callback', async () => {
  const ctx = setupTest();

  const send = createWebhookSender({
    resolveHost: () => Promise.resolve(['93.184.215.14']),
    transport: ctx.transport,
  });

  const outcome = await send({ url: 'http://hooks.example.com/hook', headers: {}, body: '{}' });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
  expect(ctx.transport).not.toHaveBeenCalled();
});

test('it reports a host that does not resolve as refused', async () => {
  const ctx = setupTest();

  const send = createWebhookSender({
    resolveHost: () => Promise.reject(new Error('getaddrinfo ENOTFOUND hooks.example.com')),
    transport: ctx.transport,
  });

  const outcome = await send({ url: 'https://hooks.example.com/hook', headers: {}, body: '{}' });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
});
