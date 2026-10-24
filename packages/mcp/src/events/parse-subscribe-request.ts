import { z } from 'zod';
import { EVENT_ERROR_CODES } from './event-error-codes';
import { EVENT_TYPES } from './event-types';
import type { EventType } from './event-types';
import { parseWebhookSecret } from './parse-webhook-secret';

// The shape the SDK checks before the handler runs, so a malformed request
// gets the protocol's invalid-params error.
export const SUBSCRIBE_PARAMS = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  delivery: z.looseObject({ mode: z.string(), url: z.string(), secret: z.string() }),
  cursor: z.string().nullable().optional(),
  ttlMs: z.number().nullable().optional(),
});

export interface SubscribeRequest {
  readonly type: EventType;
  readonly url: string;
  readonly secret: string;
  readonly secretBytes: Uint8Array;

  // The client's last cursor; null starts from the newest event.
  readonly cursor: string | null;

  // The lifetime the client suggests: undefined for the server's default,
  // null for no expiry.
  readonly ttlMs: number | null | undefined;
}

interface SubscribeRefusal {
  readonly code: number;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export type ParsedSubscribeRequest =
  | { readonly ok: true; readonly request: SubscribeRequest }
  | { readonly ok: false; readonly refusal: SubscribeRefusal };

export function parseSubscribeRequest(
  params: z.infer<typeof SUBSCRIBE_PARAMS>,
): ParsedSubscribeRequest {
  const type = EVENT_TYPES.find((candidate) => candidate.name === params.name);

  if (type === undefined) {
    return refuse(EVENT_ERROR_CODES.notFound, `no event type is named '${params.name}'`, {
      kind: 'event',
    });
  }

  if (params.arguments !== undefined && Object.keys(params.arguments).length > 0) {
    return refuse(EVENT_ERROR_CODES.invalidParams, `${type.name} takes no arguments`);
  }

  if (params.delivery.mode !== 'webhook') {
    return refuse(EVENT_ERROR_CODES.unsupported, `${type.name} delivers by webhook only`, {
      feature: 'deliveryMode',
      value: params.delivery.mode,
    });
  }

  if (!isCallbackURL(params.delivery.url)) {
    return refuse(
      EVENT_ERROR_CODES.invalidParams,
      'delivery.url must be an https URL with no credentials',
    );
  }

  const secretBytes = parseWebhookSecret(params.delivery.secret);

  if (secretBytes === null) {
    return refuse(
      EVENT_ERROR_CODES.invalidParams,
      'delivery.secret must be whsec_ followed by the base64 of 24 to 64 bytes',
    );
  }

  return {
    ok: true,
    request: {
      type,
      url: params.delivery.url,
      secret: params.delivery.secret,
      secretBytes,
      cursor: params.cursor ?? null,
      ttlMs: params.ttlMs,
    },
  };
}

function refuse(
  code: number,
  message: string,
  data?: Readonly<Record<string, unknown>>,
): ParsedSubscribeRequest {
  return { ok: false, refusal: { code, message, ...(data === undefined ? {} : { data }) } };
}

function isCallbackURL(text: string): boolean {
  if (!URL.canParse(text)) {
    return false;
  }

  const url = new URL(text);

  return url.protocol === 'https:' && url.username === '' && url.password === '';
}
