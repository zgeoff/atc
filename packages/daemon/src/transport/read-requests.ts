import { toSessionID } from '@atc/core';
import { decodeCursor, encodeCursor, parseRequestParams } from '@atc/protocol';
import type { RequestMsg } from '@atc/protocol/wire';
import type { DaemonContext } from '../daemon-context';
import type { TranscriptPosition } from '../sessions/load-transcript-page';
import type { ConnectionReply } from './connection-reply';
import type { RequestDeps } from './request-deps';

// The requests that read what a session left behind: its record, its
// transcript, the event trail, and the notes and answers in it.
export class ReadRequests {
  private readonly reply: ConnectionReply;

  constructor(deps: RequestDeps) {
    this.reply = deps.reply;
  }

  async applySessionGet(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.get', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const id = parsed.data.session;

    const record = await ctx.readSessionRecord(id, null);

    if (record === 'missing' || !ctx.isSessionVisible(id)) {
      this.reply.sendErr(req.id, 'no_such_session', `no session '${id}'`);

      return;
    }

    this.reply.sendOk(req.id, 'session.get', { ...record });
  }

  async applySessionRead(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.read', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const id = parsed.data.session;
    let from: TranscriptPosition | null = null;

    if (parsed.data.cursor !== undefined) {
      const decoded = decodeCursor(parsed.data.cursor);

      if (decoded === null || decoded.kind !== 'transcript') {
        this.reply.sendErr(
          req.id,
          'bad_args',
          `'${parsed.data.cursor}' is not a session.read cursor`,
        );

        return;
      }

      from = { path: decoded.path, offset: decoded.offset };
    }

    const read = await ctx.loadSessionTranscript(id, from, parsed.data.limit);

    if (read === 'missing' || !ctx.isSessionVisible(id)) {
      this.reply.sendErr(req.id, 'no_such_session', `no session '${id}'`);
    } else if (read === 'unsupported') {
      this.reply.sendErr(
        req.id,
        'unsupported',
        `session '${id}' runs an agent whose transcript atc cannot read`,
      );
    } else {
      this.reply.sendOk(req.id, 'session.read', {
        rows: read.page.rows,
        cursor: encodeCursor({ kind: 'transcript', path: read.path, offset: read.page.offset }),
        more: read.page.more,
      });
    }
  }

  async applyEventsRead(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('events.read', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    let afterID: number | null = null;

    if (parsed.data.cursor !== undefined) {
      const decoded = decodeCursor(parsed.data.cursor);

      if (decoded === null || decoded.kind !== 'events') {
        this.reply.sendErr(
          req.id,
          'bad_args',
          `'${parsed.data.cursor}' is not an events.read cursor`,
        );

        return;
      }

      afterID = decoded.id;
    }

    // Row ids start at 1, so a read after 0 starts at the oldest retained event.
    if (parsed.data.from === 'start') {
      afterID = 0;
    }

    const page = await ctx.readEvents(
      afterID,
      parsed.data.limit,
      parsed.data.waitMs,
      parsed.data.session ?? null,
      null,
    );

    // An event of a session that left the view while the read waited is
    // left out, as the read leaves out every event out of reach.
    const events = page.events.filter((event) => ctx.isSessionVisible(toSessionID(event.session)));
    const last = events.at(-1);

    // A cursor always comes back so a client can long-poll from an empty trail.
    this.reply.sendOk(req.id, 'events.read', {
      events,
      cursor: last === undefined ? encodeCursor({ kind: 'events', id: afterID ?? 0 }) : last.cursor,
      more: page.more,
    });
  }

  // A cursor that is not an events cursor, one at a row that holds no
  // note, and one at a note outside the access all get one refusal, so
  // the refusal is the same for a note out of reach and a missing one.
  async applyNoteGet(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('note.get', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const decoded = decodeCursor(parsed.data.note);

    const read =
      decoded === null || decoded.kind !== 'events' ? null : await ctx.readNote(decoded.id, null);

    // Reach is checked against the session that sent the note, never the
    // session its view is named by.
    if (read === null || !ctx.isSessionVisible(read.owner)) {
      this.reply.sendErr(req.id, 'bad_args', `no note '${parsed.data.note}'`);

      return;
    }

    this.reply.sendOk(req.id, 'note.get', { ...read.view });
  }

  // A cursor that is not an events cursor, one at a row that holds no
  // answer, and one at an answer outside the access all get one refusal,
  // as a note read does.
  async applyAnswerGet(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('answer.get', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const decoded = decodeCursor(parsed.data.answer);

    const read =
      decoded === null || decoded.kind !== 'events' ? null : await ctx.readAnswer(decoded.id, null);

    if (read === null || !ctx.isSessionVisible(read.owner)) {
      this.reply.sendErr(req.id, 'bad_args', `no answer '${parsed.data.answer}'`);

      return;
    }

    this.reply.sendOk(req.id, 'answer.get', { ...read.view });
  }
}
