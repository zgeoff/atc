import { match } from 'ts-pattern';
import { z } from 'zod';
import type { EventMsg } from '../protocol/protocol';
import { toMirrorSession } from './to-mirror-session';
import type { MirrorSession } from './to-mirror-session';

export type DaemonEvent =
  | { readonly ev: 'session.added'; readonly session: MirrorSession }
  | { readonly ev: 'session.state'; readonly session: MirrorSession }
  | {
      readonly ev: 'session.renamed';
      readonly s: string;
      readonly name: string;
      readonly namedBy: 'user' | 'auto' | 'agent';
    }
  | { readonly ev: 'session.removed'; readonly s: string }
  | {
      readonly ev: 'session.resized';
      readonly s: string;
      readonly cols: number;
      readonly rows: number;
    }
  | { readonly ev: 'session.output'; readonly s: string; readonly seq: number; readonly d: string }
  | { readonly ev: 'session.desync'; readonly s: string; readonly dropped: number }
  | {
      readonly ev: 'permission.requested';
      readonly request: string;
      readonly s: string;
      readonly message: string;
      readonly respondable: boolean;
    }
  | { readonly ev: 'permission.resolved'; readonly request: string; readonly decision: string };

// Every variant is a looseObject so unrecognized keys never fail a match —
// additive evolution on a known event still parses.
const DAEMON_EVENT_SCHEMA = z.discriminatedUnion('ev', [
  z.looseObject({ ev: z.literal('session.added'), session: z.unknown() }),
  z.looseObject({ ev: z.literal('session.state'), session: z.unknown() }),
  z.looseObject({
    ev: z.literal('session.renamed'),
    s: z.string(),
    name: z.string(),
    namedBy: z.enum(['user', 'auto', 'agent']),
  }),
  z.looseObject({ ev: z.literal('session.removed'), s: z.string() }),
  z.looseObject({
    ev: z.literal('session.resized'),
    s: z.string(),
    cols: z.number(),
    rows: z.number(),
  }),
  z.looseObject({
    ev: z.literal('session.output'),
    s: z.string(),
    seq: z.number(),
    d: z.string(),
  }),
  z.looseObject({ ev: z.literal('session.desync'), s: z.string(), dropped: z.number() }),
  z.looseObject({
    ev: z.literal('permission.requested'),
    request: z.string(),
    s: z.string(),
    message: z.string(),
    respondable: z.boolean(),
  }),
  z.looseObject({
    ev: z.literal('permission.resolved'),
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
    .with({ ev: 'session.added' }, { ev: 'session.state' }, (d) => {
      const session = toMirrorSession(d.session);

      return session === null ? null : { ev: d.ev, session };
    })
    .with({ ev: 'session.renamed' }, (d) => ({
      ev: d.ev,
      s: d.s,
      name: d.name,
      namedBy: d.namedBy,
    }))
    .with({ ev: 'session.removed' }, (d) => ({ ev: d.ev, s: d.s }))
    .with({ ev: 'session.resized' }, (d) => ({ ev: d.ev, s: d.s, cols: d.cols, rows: d.rows }))
    .with({ ev: 'session.output' }, (d) => ({ ev: d.ev, s: d.s, seq: d.seq, d: d.d }))
    .with({ ev: 'session.desync' }, (d) => ({ ev: d.ev, s: d.s, dropped: d.dropped }))
    .with({ ev: 'permission.requested' }, (d) => ({
      ev: d.ev,
      request: d.request,
      s: d.s,
      message: d.message,
      respondable: d.respondable,
    }))
    .with({ ev: 'permission.resolved' }, (d) => ({
      ev: d.ev,
      request: d.request,
      decision: d.decision,
    }))
    .exhaustive();
}
