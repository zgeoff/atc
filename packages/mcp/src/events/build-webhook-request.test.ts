import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { buildWebhookRequest } from './build-webhook-request';

test('it signs the id, the timestamp and the body, and names the subscription', () => {
  const secret = Buffer.alloc(32, 9);

  const request = buildWebhookRequest({
    url: 'https://hooks.example.com/hook',
    subscriptionID: 'sub_0123456789abcdef0123456789abcdef',
    webhookID: 'msg_first',
    secrets: [secret],
    timestamp: 1_761_200_000,
    body: '{"eventId":"evt_1"}',
  });

  const expected = createHmac('sha256', secret)
    .update('msg_first.1761200000.{"eventId":"evt_1"}')
    .digest('base64');

  expect(request).toStrictEqual({
    url: 'https://hooks.example.com/hook',
    headers: {
      'webhook-id': 'msg_first',
      'webhook-timestamp': '1761200000',
      'webhook-signature': `v1,${expected}`,
      'x-mcp-subscription-id': 'sub_0123456789abcdef0123456789abcdef',
    },
    body: '{"eventId":"evt_1"}',
  });
});
