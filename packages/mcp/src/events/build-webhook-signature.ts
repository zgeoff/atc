import { createHmac } from 'node:crypto';

interface SignedMessage {
  // Each secret signs the message once, so a receiver that holds any of them
  // verifies it.
  readonly secrets: readonly Uint8Array[];
  readonly webhookID: string;

  // Unix seconds.
  readonly timestamp: number;
  readonly body: string;
}

// The Standard Webhooks `webhook-signature` header value.
export function buildWebhookSignature(message: SignedMessage): string {
  const signed = `${message.webhookID}.${message.timestamp}.${message.body}`;

  return message.secrets
    .map((secret) => `v1,${createHmac('sha256', secret).update(signed).digest('base64')}`)
    .join(' ');
}
