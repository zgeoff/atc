import type { SessionID } from '@atc/core/session-id';

/**
 * Who a message send came from, as its connection and request show it: a
 * connector by the client id and name its request acts as, a session by its
 * atc id, a local program outside every session by the name it gives, or
 * the owner. The daemon turns it into the message's sender, with
 * a session's name read when the message is written.
 */
export type MessageCaller =
  | { readonly kind: 'connector'; readonly client: string; readonly name: string }
  | { readonly kind: 'session'; readonly session: SessionID }
  | { readonly kind: 'local'; readonly name: string }
  | { readonly kind: 'owner' };
