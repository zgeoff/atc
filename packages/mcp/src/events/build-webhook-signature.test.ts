import { expect, test } from 'bun:test';
import { buildWebhookSignature } from './build-webhook-signature';

test('it signs the Standard Webhooks test vector to its published signature', () => {
  expect(
    buildWebhookSignature({
      secrets: [Buffer.from('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'base64')],
      webhookID: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      timestamp: 1_614_265_330,
      body: '{"test": 2432232314}',
    }),
  ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
});

test('it signs once with each secret, separated by a space', () => {
  const signature = buildWebhookSignature({
    secrets: [Buffer.alloc(32, 1), Buffer.alloc(32, 2)],
    webhookID: 'msg_rotation',
    timestamp: 1_700_000_000,
    body: '{}',
  });

  expect(signature.split(' ')).toStrictEqual([
    buildWebhookSignature({
      secrets: [Buffer.alloc(32, 1)],
      webhookID: 'msg_rotation',
      timestamp: 1_700_000_000,
      body: '{}',
    }),
    buildWebhookSignature({
      secrets: [Buffer.alloc(32, 2)],
      webhookID: 'msg_rotation',
      timestamp: 1_700_000_000,
      body: '{}',
    }),
  ]);
});
