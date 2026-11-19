import { buildWebhookSignature } from './build-webhook-signature';
import type { WebhookRequest } from './types';

interface WebhookMessage {
  readonly url: string;
  readonly subscriptionID: string;

  // Names the message, and stays the same on each retry of it.
  readonly webhookID: string;
  readonly secrets: readonly Uint8Array[];

  // Unix seconds, taken afresh for each attempt.
  readonly timestamp: number;
  readonly body: string;
}

// Standard Webhooks signs the exact body bytes, so send the body unchanged; re-serializing it
// breaks the receiver's signature check.
export function buildWebhookRequest(message: WebhookMessage): WebhookRequest {
  return {
    url: message.url,
    headers: {
      'webhook-id': message.webhookID,
      'webhook-timestamp': String(message.timestamp),
      'webhook-signature': buildWebhookSignature(message),
      'x-mcp-subscription-id': message.subscriptionID,
    },
    body: message.body,
  };
}
