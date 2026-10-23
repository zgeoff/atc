import type { WebhookOutcome } from './types';

export type DeliveryStep =
  | { readonly kind: 'done' }
  | { readonly kind: 'retry'; readonly delayMs: number }
  | { readonly kind: 'abandon' }
  | { readonly kind: 'drop' };

// The waits before each retry. The extension asks for three to five attempts
// within ten to fifteen minutes, and a subscriber that missed every attempt
// catches up by reading the trail from its cursor.
const RETRY_DELAYS_MS = [30_000, 120_000, 480_000];

// What a delivery does after its attempt numbered `attempt`, counting from 1.
// The extension makes 410 and 413 final: 410 ends the subscription, and 413
// would answer the same body the same way again.
export function pickDeliveryStep(outcome: WebhookOutcome, attempt: number): DeliveryStep {
  if (outcome.kind === 'answered' && outcome.status >= 200 && outcome.status <= 299) {
    return { kind: 'done' };
  }

  if (outcome.kind === 'answered' && outcome.status === 410) {
    return { kind: 'drop' };
  }

  if (outcome.kind === 'answered' && outcome.status === 413) {
    return { kind: 'abandon' };
  }

  const delayMs = RETRY_DELAYS_MS[attempt - 1];

  return delayMs === undefined ? { kind: 'abandon' } : { kind: 'retry', delayMs };
}
