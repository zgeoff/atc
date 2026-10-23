import type { SessionID } from '@atcx/contract';

export type MessageCaller =
  | { readonly kind: 'connector'; readonly client: string; readonly name: string }
  | { readonly kind: 'session'; readonly session: SessionID }
  | { readonly kind: 'local'; readonly name: string }
  | { readonly kind: 'owner' };
