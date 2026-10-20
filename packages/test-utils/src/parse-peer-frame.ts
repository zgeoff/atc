import { isRecord } from '@atc/core';
import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';
import { MessageType, deserializeResponseMessage } from '@orpc/standard-server-peer';
import type { BaseMessageFormat, DecodedResponseMessage } from '@orpc/standard-server-peer';

// One message a daemon wrote to a peer client, decoded the way the client
// decodes it: a response with its status and body, one event of a stream, or
// the end of a stream the daemon aborted.
export type PeerFrame =
  | {
      readonly kind: 'response';
      readonly id: string;
      readonly status: number;
      readonly headers: Readonly<Record<string, string | string[] | undefined>>;
      readonly body: unknown;
    }
  | { readonly kind: 'event'; readonly id: string; readonly event: string; readonly data: unknown }
  | { readonly kind: 'abort'; readonly id: string };

const SERIALIZER = new StandardRPCSerializer(new StandardRPCJsonSerializer());

type AbortMessage = Extract<
  DecodedResponseMessage,
  readonly [string, MessageType.ABORT_SIGNAL, unknown]
>;

export function parsePeerFrame(line: string): PeerFrame {
  const parsed: unknown = JSON.parse(line);

  if (!isPeerMessage(parsed)) {
    throw new TypeError(`a peer frame is a JSON object with a string id, not ${line}`);
  }

  const message = deserializeResponseMessage(parsed);

  if (message[1] === MessageType.RESPONSE) {
    const [id, , payload] = message;

    return {
      kind: 'response',
      id,
      status: payload.status,
      headers: payload.headers,
      body: payload.body === undefined ? undefined : SERIALIZER.deserialize(payload.body),
    };
  }

  if (message[1] === MessageType.EVENT_ITERATOR) {
    const [id, , payload] = message;

    return {
      kind: 'event',
      id,
      event: payload.event,
      data: payload.data === undefined ? undefined : SERIALIZER.deserialize(payload.data),
    };
  }

  // A message type with no branch above fails the type check here, so a new
  // one cannot fall through as an abort.
  const abort: AbortMessage = message;

  return { kind: 'abort', id: abort[0] };
}

function isPeerMessage(value: unknown): value is BaseMessageFormat {
  return isRecord(value) && typeof value['i'] === 'string';
}
