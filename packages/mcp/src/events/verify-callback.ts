import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isRecord } from '@atc/core';
import { buildWebhookRequest } from './build-webhook-request';
import type { WebhookFailure, WebhookSender } from './types';

interface CallbackCheck {
  readonly send: WebhookSender;
  readonly url: string;
  readonly subscriptionID: string;
  readonly secret: Uint8Array;

  // Unix seconds.
  readonly timestamp: number;
}

// The categories the Events extension lets a refused subscribe report.
type CallbackFailure = WebhookFailure | 'http_4xx' | 'http_5xx' | 'challenge_failed';

export type CallbackVerdict =
  | { readonly verified: true }
  | { readonly verified: false; readonly reason: CallbackFailure };

// The endpoint proves it wants the deliveries by echoing a one-time challenge
// that only a holder of the secret can trust, since the envelope is signed.
export async function verifyCallback(check: CallbackCheck): Promise<CallbackVerdict> {
  const challenge = randomBytes(24).toString('base64url');

  const outcome = await check.send(
    buildWebhookRequest({
      url: check.url,
      subscriptionID: check.subscriptionID,
      webhookID: `msg_verification_${randomBytes(12).toString('base64url')}`,
      secrets: [check.secret],
      timestamp: check.timestamp,
      body: JSON.stringify({ type: 'verification', challenge }),
    }),
  );

  if (outcome.kind === 'failed') {
    return { verified: false, reason: outcome.reason };
  }

  if (outcome.status >= 500) {
    return { verified: false, reason: 'http_5xx' };
  }

  if (outcome.status >= 400) {
    return { verified: false, reason: 'http_4xx' };
  }

  // A redirect is never followed, so it fails the challenge as a wrong echo does.
  return outcome.status >= 200 && outcome.status <= 299 && isEchoed(outcome.body, challenge)
    ? { verified: true }
    : { verified: false, reason: 'challenge_failed' };
}

function isEchoed(body: string, challenge: string): boolean {
  let answer: unknown;

  try {
    answer = JSON.parse(body);
  } catch {
    return false;
  }

  const echoed = isRecord(answer) ? answer['challenge'] : undefined;

  if (typeof echoed !== 'string') {
    return false;
  }

  const expected = Buffer.from(challenge);
  const received = Buffer.from(echoed);

  return expected.length === received.length && timingSafeEqual(expected, received);
}
