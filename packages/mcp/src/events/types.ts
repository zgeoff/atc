// One signed POST to a subscriber's callback URL.
export interface WebhookRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

// The failure categories the Events extension lets a server report, so a
// reply never carries what the endpoint sent.
export type WebhookFailure = 'connection_refused' | 'timeout' | 'tls_error';

export type WebhookOutcome =
  | { readonly kind: 'answered'; readonly status: number; readonly body: string }
  | { readonly kind: 'failed'; readonly reason: WebhookFailure };

export type WebhookSender = (request: WebhookRequest) => Promise<WebhookOutcome>;
