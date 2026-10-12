import { match } from 'ts-pattern';
import { z } from 'zod';
import type { EventMsg } from '../protocol/protocol';
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

/**
 * Turns a raw event line into the typed union, or null when the kind is
 * unrecognized or a known kind's payload is malformed. Total by design: a
 * miss is dropped by the caller, never thrown.
 */
export function parseDaemonEvent(raw: EventMsg): DaemonEvent | null {
  const parsed = DAEMON_EVENT_SCHEMA.safeParse(raw);

  if (!parsed.success) {
    return null;
  }

  return match(parsed.data)
    .with({ ev: 'SessionAdded' }, { ev: 'SessionState' }, (d) => {
      const session = toMirrorSession(d.session);

      return session === null ? null : { ev: d.ev, session };
    })
    .with({ ev: 'SessionRenamed' }, (d) => ({
      ev: d.ev,
      s: d.s,
      name: d.name,
      namedBy: d.namedBy,
    }))
    .with({ ev: 'SessionRemoved' }, (d) => ({ ev: d.ev, s: d.s }))
    .with({ ev: 'SessionResized' }, (d) => ({ ev: d.ev, s: d.s, cols: d.cols, rows: d.rows }))
    .with({ ev: 'SessionOutput' }, (d) => ({ ev: d.ev, s: d.s, seq: d.seq, d: d.d }))
    .with({ ev: 'SessionDesync' }, (d) => ({ ev: d.ev, s: d.s, dropped: d.dropped }))
    .with({ ev: 'PermissionRequested' }, (d) => ({
      ev: d.ev,
      request: d.request,
      s: d.s,
      message: d.message,
      respondable: d.respondable,
    }))
    .with({ ev: 'PermissionResolved' }, (d) => ({
      ev: d.ev,
      request: d.request,
      decision: d.decision,
    }))
    .exhaustive();
}
