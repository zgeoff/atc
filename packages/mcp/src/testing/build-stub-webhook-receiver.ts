import { isRecord } from '@atc/core';
import type {
  WebhookFailure,
  WebhookOutcome,
  WebhookRequest,
  WebhookSender,
} from '../events/types';

type StubWebhookAnswer = { readonly status: number } | { readonly failure: WebhookFailure };

interface StubWebhookReceiverConfig {
  // How the receiver answers each event delivery, in order; 200 once the
  // list runs out.
  readonly answers?: readonly StubWebhookAnswer[];

  // Whether it echoes a verification challenge, as an endpoint that wants the
  // deliveries does; true by default.
  readonly echoes?: boolean;
}

// Stands in for a subscriber's endpoint across the internet, which a test
// cannot reach: it records each signed POST and answers it as configured.
export function buildStubWebhookReceiver(config: StubWebhookReceiverConfig = {}): {
  readonly send: WebhookSender;
  readonly received: readonly WebhookRequest[];
} {
  const received: WebhookRequest[] = [];
  const answers = [...(config.answers ?? [])];

  return {
    received,
    send: (request) => {
      received.push(request);

      const challenge = readChallenge(request.body);

      if (challenge !== null) {
        const echo = config.echoes === false ? {} : { challenge };

        return Promise.resolve({ kind: 'answered', status: 200, body: JSON.stringify(echo) });
      }

      const answer = answers.shift() ?? { status: 200 };

      const outcome: WebhookOutcome =
        'failure' in answer
          ? { kind: 'failed', reason: answer.failure }
          : { kind: 'answered', status: answer.status, body: '' };

      return Promise.resolve(outcome);
    },
  };
}

function readChallenge(body: string): string | null {
  const parsed: unknown = JSON.parse(body);

  return isRecord(parsed) &&
    parsed['type'] === 'verification' &&
    typeof parsed['challenge'] === 'string'
    ? parsed['challenge']
    : null;
}
