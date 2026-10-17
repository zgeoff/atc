import type { SessionID } from '@atc/core';
import { parseRequestParams } from '@atc/protocol';
import type { RequestMsg } from '@atc/protocol/wire';
import { match } from 'ts-pattern';
import type { DaemonContext, OutputClient } from '../daemon-context';
import type { ConnectionReply } from './connection-reply';
import type { RequestDeps } from './request-deps';

// The requests that drive a session's terminal: attaching to it, typing
// into it, resizing it, and answering its menus and permission prompts.
export class TerminalRequests {
  private readonly client: OutputClient;

  private readonly reply: ConnectionReply;

  constructor(deps: RequestDeps) {
    this.client = deps.client;
    this.reply = deps.reply;
  }

  applyAttach(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.attach', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    const result = ctx.attachSession(this.client, sessionID, {
      cols: parsed.data.cols,
      rows: parsed.data.rows,
    });

    if (result === 'missing') {
      this.reply.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    if (result === 'dead') {
      this.reply.sendErr(req.id, 'session_dead', `session '${sessionID}' has no live process`);

      return;
    }

    const dims = ctx.getEffectiveDims(sessionID);

    this.reply.sendOk(req.id, 'session.attach', { cols: dims.cols, rows: dims.rows });
  }

  applyInput(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.input', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    this.sendInputResult(
      req,
      'session.input',
      sessionID,
      ctx.writeSessionInput(sessionID, parsed.data.d),
    );
  }

  async applySubmit(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.submit', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    const result = await ctx.writeSessionLine(sessionID, parsed.data.text);

    this.sendInputResult(req, 'session.submit', sessionID, result);
  }

  applySessionMenu(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.menu', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const id = parsed.data.session;

    if (!ctx.isSessionVisible(id)) {
      this.reply.sendErr(req.id, 'no_such_session', `no session '${id}'`);

      return;
    }

    // A read rejects with a DaemonError when the menu changes or ignores a key. The session
    // can leave the caller's view while the read runs, so its view is checked again before
    // the menu goes out.
    this.reply.answerAsync(req.id, async () => {
      const menu = await ctx.readSessionMenu(id);

      if (menu === 'missing' || !ctx.isSessionVisible(id)) {
        this.reply.sendErr(req.id, 'no_such_session', `no session '${id}'`);
      } else if (menu === 'no_screen') {
        this.reply.sendErr(req.id, 'session_dead', `session '${id}' has no captured screen`);
      } else if (menu === 'unsupported') {
        this.reply.sendErr(req.id, 'unsupported', `atc cannot read the menus in session '${id}'`);
      } else {
        this.reply.sendOk(req.id, 'session.menu', { menu });
      }
    });
  }

  // A choice whose menu, label, or cursor does not match the screen rejects
  // with its DaemonError, which answers with that error's code.
  applySessionChoose(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.choose', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const id = parsed.data.session;
    const menuToken = parsed.data.menuToken;

    if (!ctx.isSessionVisible(id)) {
      this.reply.sendErr(req.id, 'no_such_session', `no session '${id}'`);

      return;
    }

    const choice =
      parsed.data.key === 'escape'
        ? { menuToken, key: parsed.data.key }
        : { menuToken, option: parsed.data.option ?? 0, label: parsed.data.label ?? '' };

    this.reply.answerAsync(req.id, async () => {
      const result = await ctx.applySessionMenuChoice(id, choice);

      if (result === 'missing') {
        this.reply.sendErr(req.id, 'no_such_session', `no session '${id}'`);
      } else if (result === 'dead') {
        this.reply.sendErr(req.id, 'session_dead', `session '${id}' has no live process`);
      } else if (result === 'unsupported') {
        this.reply.sendErr(req.id, 'unsupported', `atc cannot read the menus in session '${id}'`);
      } else {
        this.reply.sendOk(req.id, 'session.choose', { ...result });
      }
    });
  }

  private sendInputResult(
    req: RequestMsg,
    method: 'session.input' | 'session.submit',
    sessionID: SessionID,
    result: 'busy' | 'ok' | 'missing' | 'dead' | 'permission_pending',
  ): void {
    if (result === 'permission_pending') {
      this.reply.sendErr(
        req.id,
        'permission_pending',
        `session '${sessionID}' is waiting on a permission prompt, where typed text picks the highlighted option; answer the prompt's menu with session.choose or in the atc TUI`,
      );

      return;
    }

    if (result === 'missing') {
      this.reply.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    if (result === 'dead') {
      this.reply.sendErr(req.id, 'session_dead', `session '${sessionID}' has no live process`);

      return;
    }

    if (result === 'busy') {
      this.reply.sendErr(
        req.id,
        'too_slow',
        `session '${sessionID}' is mid-run; wait for the turn to end`,
      );

      return;
    }

    this.reply.sendOk(req.id, method, {});
  }

  applyResize(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.resize', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    if (
      !ctx.resizeSession(this.client, sessionID, { cols: parsed.data.cols, rows: parsed.data.rows })
    ) {
      this.reply.sendErr(req.id, 'bad_args', `not attached to session '${sessionID}'`);

      return;
    }

    this.reply.sendOk(req.id, 'session.resize', {});
  }

  applyPermissionRespond(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('permission.respond', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const request = parsed.data.request;
    const decision = parsed.data.decision;
    const result = ctx.answerPermission(request, decision);

    match(result)
      .with('ok', () => {
        this.reply.sendOk(req.id, 'permission.respond', {});
      })
      .with('already_answered', () => {
        this.reply.sendErr(req.id, 'already_answered', `request '${request}' was already answered`);
      })
      .with('unsupported', () => {
        this.reply.sendErr(
          req.id,
          'unsupported',
          `request '${request}' is answered with keystrokes`,
        );
      })
      .with('unknown', () => {
        this.reply.sendErr(req.id, 'bad_args', `unknown permission request '${request}'`);
      })
      .exhaustive();
  }
}
