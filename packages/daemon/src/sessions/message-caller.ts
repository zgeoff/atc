import type { SessionID } from '@atc/core';

export type MessageCaller =
  | { readonly kind: 'connector'; readonly client: string; readonly name: string }
  | { readonly kind: 'session'; readonly session: SessionID }
  | { readonly kind: 'local'; readonly name: string }
  | { readonly kind: 'owner' };
