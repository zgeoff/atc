import { match } from 'ts-pattern';
import { z } from 'zod';
import { toMirrorSession } from './to-mirror-session';
import type { MirrorSession } from './to-mirror-session';

export type DaemonEvent =
  | { readonly ev: 'SessionAdded'; readonly session: MirrorSession }
  | { readonly ev: 'SessionState'; readonly session: MirrorSession }
  | {
      readonly ev: 'SessionRenamed';
      readonly s: string;
      readonly name: string;
      readonly namedBy: 'user' | 'auto' | 'agent';
    }
  | { readonly ev: 'SessionRemoved'; readonly s: string }
  | {
      readonly ev: 'SessionResized';
      readonly s: string;
      readonly cols: number;
      readonly rows: number;
    }
  | { readonly ev: 'SessionOutput'; readonly s: string; readonly seq: number; readonly d: string }
  | { readonly ev: 'SessionDesync'; readonly s: string; readonly dropped: number }
  | {
      readonly ev: 'PermissionRequested';
      readonly request: string;
      readonly s: string;
      readonly message: string;
      readonly respondable: boolean;
    }
  | { readonly ev: 'PermissionResolved'; readonly request: string; readonly decision: string };

// Every variant is a looseObject so unrecognized keys never fail a match —
// additive evolution on a known event still parses.
const DAEMON_EVENT_SCHEMA = z.discriminatedUnion('ev', [
  z.looseObject({ ev: z.literal('SessionAdded'), session: z.unknown() }),
  z.looseObject({ ev: z.literal('SessionState'), session: z.unknown() }),
  z.looseObject({
    ev: z.literal('SessionRenamed'),
    s: z.string(),
    name: z.string(),
    namedBy: z.enum(['user', 'auto', 'agent']),
  }),
  z.looseObject({ ev: z.literal('SessionRemoved'), s: z.string() }),
  z.looseObject({
    ev: z.literal('SessionResized'),
    s: z.string(),
    cols: z.number(),
    rows: z.number(),
  }),
  z.looseObject({
    ev: z.literal('SessionOutput'),
    s: z.string(),
    seq: z.number(),
    d: z.string(),
  }),
  z.looseObject({ ev: z.literal('SessionDesync'), s: z.string(), dropped: z.number() }),
  z.looseObject({
    ev: z.literal('PermissionRequested'),
    request: z.string(),
    s: z.string(),
    message: z.string(),
    respondable: z.boolean(),
  }),
  z.looseObject({
    ev: z.literal('PermissionResolved'),
    request: z.string(),
    decision: z.string(),
  }),
]);

// An event as the daemon sent it, before the client parsed it.
export interface RawDaemonEvent {
  readonly ev: string;
  readonly [field: string]: unknown;
}

export function parseDaemonEvent(raw: RawDaemonEvent): DaemonEvent | null {
  const parsed = DAEMON_EVENT_SCHEMA.safeParse(raw);

  if (!parsed.success) {
    return null;
  }

  return match(parsed.data)
    .with({ ev: 'SessionAdded' }, { ev: 'SessionState' }, (payload) => {
      const session = toMirrorSession(payload.session);

      return session === null ? null : { ev: payload.ev, session };
    })
    .with({ ev: 'SessionRenamed' }, (payload) => ({
      ev: payload.ev,
      s: payload.s,
      name: payload.name,
      namedBy: payload.namedBy,
    }))
    .with({ ev: 'SessionRemoved' }, (payload) => ({ ev: payload.ev, s: payload.s }))
    .with({ ev: 'SessionResized' }, (payload) => ({
      ev: payload.ev,
      s: payload.s,
      cols: payload.cols,
      rows: payload.rows,
    }))
    .with({ ev: 'SessionOutput' }, (payload) => ({
      ev: payload.ev,
      s: payload.s,
      seq: payload.seq,
      d: payload.d,
    }))
    .with({ ev: 'SessionDesync' }, (payload) => ({
      ev: payload.ev,
      s: payload.s,
      dropped: payload.dropped,
    }))
    .with({ ev: 'PermissionRequested' }, (payload) => ({
      ev: payload.ev,
      request: payload.request,
      s: payload.s,
      message: payload.message,
      respondable: payload.respondable,
    }))
    .with({ ev: 'PermissionResolved' }, (payload) => ({
      ev: payload.ev,
      request: payload.request,
      decision: payload.decision,
    }))
    .exhaustive();
}
