import { expect, test } from 'bun:test';
import { buildStubWebhookReceiver } from './build-stub-webhook-receiver';

test('it echoes a verification challenge', async () => {
  const receiver = buildStubWebhookReceiver();

  const outcome = await receiver.send({
    url: 'https://hooks.example.com/hook',
    headers: {},
    body: '{"type":"verification","challenge":"nonce-1"}',
  });

  expect(outcome).toStrictEqual({ kind: 'answered', status: 200, body: '{"challenge":"nonce-1"}' });
});

test('it answers a challenge without the echo when told not to echo', async () => {
  const receiver = buildStubWebhookReceiver({ echoes: false });

  const outcome = await receiver.send({
    url: 'https://hooks.example.com/hook',
    headers: {},
    body: '{"type":"verification","challenge":"nonce-1"}',
  });

  expect(outcome).toStrictEqual({ kind: 'answered', status: 200, body: '{}' });
});

test('it answers event deliveries in the order given, then with 200', async () => {
  const receiver = buildStubWebhookReceiver({
    answers: [{ status: 503 }, { failure: 'timeout' }],
  });

  const delivery = { url: 'https://hooks.example.com/hook', headers: {}, body: '{"eventId":"e"}' };

  const outcomes = [
    await receiver.send(delivery),
    await receiver.send(delivery),
    await receiver.send(delivery),
  ];

  expect(outcomes).toStrictEqual([
    { kind: 'answered', status: 503, body: '' },
    { kind: 'failed', reason: 'timeout' },
    { kind: 'answered', status: 200, body: '' },
  ]);
});

test('it records each request it receives', async () => {
  const receiver = buildStubWebhookReceiver();

  await receiver.send({
    url: 'https://hooks.example.com/hook',
    headers: { 'webhook-id': 'msg_1' },
    body: '{"eventId":"e"}',
  });

  expect(receiver.received).toStrictEqual([
    {
      url: 'https://hooks.example.com/hook',
      headers: { 'webhook-id': 'msg_1' },
      body: '{"eventId":"e"}',
    },
  ]);
});
