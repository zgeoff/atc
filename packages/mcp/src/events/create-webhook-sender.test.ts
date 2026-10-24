import { expect, mock, test } from 'bun:test';
import { createTestCertificate, makeTrustingTransport, registerTestCleanup } from '@atc/test-utils';
import { createWebhookSender } from './create-webhook-sender';
import { isPublicAddress } from './is-public-address';

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
    isAllowedAddress: isPublicAddress,
    transport: ctx.transport,
    timeoutMs: 10_000,
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

test('it delivers the POST over TLS to the address it checked, under the callback host certificate', async () => {
  const certificate = await createTestCertificate('hooks.example.test');

  const received: { host: string | null; body: string }[] = [];

  const answerRequest = async (request: Request) => {
    received.push({ host: request.headers.get('host'), body: await request.text() });

    return new Response('{"ok":true}');
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: certificate.cert, key: certificate.key },
    fetch: answerRequest,
  });

  registerTestCleanup(() => server.stop(true));

  const send = createWebhookSender({
    resolveHost: () => Promise.resolve(['127.0.0.1']),
    isAllowedAddress: (address) => address === '127.0.0.1',
    transport: makeTrustingTransport(certificate.cert),
    timeoutMs: 10_000,
  });

  const outcome = await send({
    url: `https://hooks.example.test:${server.port}/hook`,
    headers: { 'webhook-id': 'msg_1' },
    body: '{"name":"session.turn_done"}',
  });

  expect(outcome).toStrictEqual({ kind: 'answered', status: 200, body: '{"ok":true}' });

  expect(received).toStrictEqual([
    { host: `hooks.example.test:${server.port}`, body: '{"name":"session.turn_done"}' },
  ]);
});

test('it reports a certificate for another host as a TLS failure and posts nothing', async () => {
  const certificate = await createTestCertificate('other.example.test');

  const received = mock(() => new Response('{}'));

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: certificate.cert, key: certificate.key },
    fetch: received,
  });

  registerTestCleanup(() => server.stop(true));

  const send = createWebhookSender({
    resolveHost: () => Promise.resolve(['127.0.0.1']),
    isAllowedAddress: (address) => address === '127.0.0.1',
    transport: makeTrustingTransport(certificate.cert),
    timeoutMs: 10_000,
  });

  const outcome = await send({
    url: `https://hooks.example.test:${server.port}/hook`,
    headers: {},
    body: '{}',
  });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'tls_error' });
  expect(received).not.toHaveBeenCalled();
});

test('it reports a TLS callback that never answers as a timeout', async () => {
  const certificate = await createTestCertificate('hooks.example.test');

  const received = mock(() => Promise.withResolvers<Response>().promise);

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: certificate.cert, key: certificate.key },
    fetch: received,
  });

  registerTestCleanup(() => server.stop(true));

  const send = createWebhookSender({
    resolveHost: () => Promise.resolve(['127.0.0.1']),
    isAllowedAddress: (address) => address === '127.0.0.1',
    transport: makeTrustingTransport(certificate.cert),
    timeoutMs: 200,
  });

  const outcome = await send({
    url: `https://hooks.example.test:${server.port}/hook`,
    headers: {},
    body: '{}',
  });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'timeout' });
  expect(received).toHaveBeenCalledOnce();
});

test('it refuses a host that resolves to a loopback address without connecting', async () => {
  const ctx = setupTest();

  const send = createWebhookSender({
    resolveHost: () => Promise.resolve(['127.0.0.1']),
    isAllowedAddress: isPublicAddress,
    transport: ctx.transport,
    timeoutMs: 10_000,
  });

  const outcome = await send({ url: 'https://hooks.example.com/hook', headers: {}, body: '{}' });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
  expect(ctx.transport).not.toHaveBeenCalled();
});

test('it refuses a host when any of its addresses is private', async () => {
  const ctx = setupTest();

  const send = createWebhookSender({
    resolveHost: () => Promise.resolve(['93.184.215.14', '10.0.0.8']),
    isAllowedAddress: isPublicAddress,
    transport: ctx.transport,
    timeoutMs: 10_000,
  });

  const outcome = await send({ url: 'https://hooks.example.com/hook', headers: {}, body: '{}' });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
  expect(ctx.transport).not.toHaveBeenCalled();
});

test('it refuses a callback written as a loopback address without resolving it', async () => {
  const ctx = setupTest();
  const resolveHost = mock(() => Promise.resolve(['93.184.215.14']));

  const send = createWebhookSender({
    resolveHost,
    isAllowedAddress: isPublicAddress,
    transport: ctx.transport,
    timeoutMs: 10_000,
  });

  const outcome = await send({ url: 'https://127.0.0.1:8443/hook', headers: {}, body: '{}' });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
  expect(resolveHost).not.toHaveBeenCalled();
  expect(ctx.transport).not.toHaveBeenCalled();
});

test('it refuses a plain http callback', async () => {
  const ctx = setupTest();

  const send = createWebhookSender({
    resolveHost: () => Promise.resolve(['93.184.215.14']),
    isAllowedAddress: isPublicAddress,
    transport: ctx.transport,
    timeoutMs: 10_000,
  });

  const outcome = await send({ url: 'http://hooks.example.com/hook', headers: {}, body: '{}' });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
  expect(ctx.transport).not.toHaveBeenCalled();
});

test('it reports a host that does not resolve as refused', async () => {
  const ctx = setupTest();

  const send = createWebhookSender({
    resolveHost: () => Promise.reject(new Error('getaddrinfo ENOTFOUND hooks.example.com')),
    isAllowedAddress: isPublicAddress,
    transport: ctx.transport,
    timeoutMs: 10_000,
  });

  const outcome = await send({ url: 'https://hooks.example.com/hook', headers: {}, body: '{}' });

  expect(outcome).toStrictEqual({ kind: 'failed', reason: 'connection_refused' });
});
