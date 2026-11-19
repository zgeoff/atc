import { decodeCursor, encodeCursor } from '@atc/protocol';
import type { DaemonAnswer, RequestParams } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import { toSessionID } from '@atcx/contract';
import type { TranscriptPosition } from '../sessions/load-transcript-page';
import type { DaemonContext } from '../types';

export interface ReadRequests {
  readonly applySessionGet: (
    data: RequestParams<'session.get'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'session.get'>>;

  readonly applySessionRead: (
    data: RequestParams<'session.read'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'session.read'>>;

  readonly applyEventsRead: (
    data: RequestParams<'events.read'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'events.read'>>;

  readonly applyNoteGet: (
    data: RequestParams<'note.get'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'note.get'>>;

  readonly applyAnswerGet: (
    data: RequestParams<'answer.get'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'answer.get'>>;
}

export function buildReadRequests(): ReadRequests {
  return {
    applySessionGet: async (data, ctx) => {
      const id = data.session;

      const record = await ctx.readSessionRecord(id, null);

      if (record === 'missing' || !ctx.isSessionVisible(id)) {
        throw new DaemonError('no_such_session', `no session '${id}'`);
      }

      return { ...record };
    },

    applySessionRead: async (data, ctx) => {
      const id = data.session;
      let from: TranscriptPosition | null = null;

      if (data.cursor !== undefined) {
        const decoded = decodeCursor(data.cursor);

        if (decoded === null || decoded.kind !== 'transcript') {
          throw new DaemonError('bad_args', `'${data.cursor}' is not a session.read cursor`);
        }

        from = { path: decoded.path, offset: decoded.offset };
      }

      const read = await ctx.loadSessionTranscript(id, from, data.limit);

      if (read === 'missing' || !ctx.isSessionVisible(id)) {
        throw new DaemonError('no_such_session', `no session '${id}'`);
      }

      if (read === 'unsupported') {
        throw new DaemonError(
          'unsupported',
          `session '${id}' runs an agent whose transcript atc cannot read`,
        );
      }

      return {
        rows: read.page.rows,
        cursor: encodeCursor({ kind: 'transcript', path: read.path, offset: read.page.offset }),
        more: read.page.more,
      };
    },

    applyEventsRead: async (data, ctx) => {
      let afterID: number | null = null;

      if (data.cursor !== undefined) {
        const decoded = decodeCursor(data.cursor);

        if (decoded === null || decoded.kind !== 'events') {
          throw new DaemonError('bad_args', `'${data.cursor}' is not an events.read cursor`);
        }

        afterID = decoded.id;
      }

      // Row ids start at 1, so a read after 0 starts at the oldest retained event.
      if (data.from === 'start') {
        afterID = 0;
      }

      const page = await ctx.readEvents({
        afterID,
        limit: data.limit,
        waitMs: data.waitMs,
        sessionID: data.session ?? null,
        access: null,
      });

      const events = page.events.filter((event) =>
        ctx.isSessionVisible(toSessionID(event.session)),
      );

      const last = events.at(-1);

      return {
        events,
        cursor:
          last === undefined ? encodeCursor({ kind: 'events', id: afterID ?? 0 }) : last.cursor,
        more: page.more,
      };
    },

    applyNoteGet: async (data, ctx) => {
      const decoded = decodeCursor(data.note);

      const read =
        decoded === null || decoded.kind !== 'events' ? null : await ctx.readNote(decoded.id, null);

      // Reach is checked against the session that sent the note, never the
      // session its view is named by.
      if (read === null || !ctx.isSessionVisible(read.owner)) {
        throw new DaemonError('bad_args', `no note '${data.note}'`);
      }

      return { ...read.view };
    },

    applyAnswerGet: async (data, ctx) => {
      const decoded = decodeCursor(data.answer);

      const read =
        decoded === null || decoded.kind !== 'events'
          ? null
          : await ctx.readAnswer(decoded.id, null);

      if (read === null || !ctx.isSessionVisible(read.owner)) {
        throw new DaemonError('bad_args', `no answer '${data.answer}'`);
      }

      return { ...read.view };
    },
  };
}
