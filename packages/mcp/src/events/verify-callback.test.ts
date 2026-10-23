import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import invariant from 'tiny-invariant';
import { buildStubWebhookReceiver } from '../testing/build-stub-webhook-receiver';
import { verifyCallback } from './verify-callback';

test('it verifies an endpoint that echoes the challenge', async () => {
  const receiver = buildStubWebhookReceiver();

  const verdict = await verifyCallback({
    send: receiver.send,
    url: 'https://hooks.example.com/hook',
    subscriptionID: 'sub_0123456789abcdef0123456789abcdef',
    secret: Buffer.alloc(32, 3),
    timestamp: 1_761_200_000,
  });

  expect(verdict).toStrictEqual({ verified: true });
});

test('it posts a signed verification envelope that names the subscription', async () => {
  const receiver = buildStubWebhookReceiver();
  const secret = Buffer.alloc(32, 3);

  await verifyCallback({
    send: receiver.send,
    url: 'https://hooks.example.com/hook',
    subscriptionID: 'sub_0123456789abcdef0123456789abcdef',
    secret,
    timestamp: 1_761_200_000,
  });

  const [request] = receiver.received;

  invariant(request, 'the endpoint received no envelope');

  const webhookID = request.headers['webhook-id'] ?? '';
  const signed = `${webhookID}.1761200000.${request.body}`;

  expect(request).toStrictEqual({
    url: 'https://hooks.example.com/hook',
    headers: {
      'webhook-id': expect.stringMatching(/^msg_verification_[\w-]+$/u),
      'webhook-timestamp': '1761200000',
      'webhook-signature': `v1,${createHmac('sha256', secret).update(signed).digest('base64')}`,
      'x-mcp-subscription-id': 'sub_0123456789abcdef0123456789abcdef',
    },
    body: expect.stringMatching(/^\{"type":"verification","challenge":"[\w-]+"\}$/u),
  });
});

test('it refuses an endpoint that answers without the challenge as challenge_failed', async () => {
  const receiver = buildStubWebhookReceiver({ echoes: false });

  const verdict = await verifyCallback({
    send: receiver.send,
    url: 'https://hooks.example.com/hook',
    subscriptionID: 'sub_0123456789abcdef0123456789abcdef',
    secret: Buffer.alloc(32, 3),
    timestamp: 1_761_200_000,
  });

  expect(verdict).toStrictEqual({ verified: false, reason: 'challenge_failed' });
});

test.each([
  ['a 404 as http_4xx', 404, 'http_4xx' as const],
  ['a 503 as http_5xx', 503, 'http_5xx' as const],
  ['a redirect as challenge_failed', 302, 'challenge_failed' as const],
])('it refuses %s', async (_label, status, reason) => {
  const verdict = await verifyCallback({
    send: () => Promise.resolve({ kind: 'answered', status, body: '' }),
    url: 'https://hooks.example.com/hook',
    subscriptionID: 'sub_0123456789abcdef0123456789abcdef',
    secret: Buffer.alloc(32, 3),
    timestamp: 1_761_200_000,
  });

  expect(verdict).toStrictEqual({ verified: false, reason });
});

test('it refuses an endpoint it cannot reach with the failure category', async () => {
  const verdict = await verifyCallback({
    send: () => Promise.resolve({ kind: 'failed', reason: 'timeout' }),
    url: 'https://hooks.example.com/hook',
    subscriptionID: 'sub_0123456789abcdef0123456789abcdef',
    secret: Buffer.alloc(32, 3),
    timestamp: 1_761_200_000,
  });

  expect(verdict).toStrictEqual({ verified: false, reason: 'timeout' });
});
