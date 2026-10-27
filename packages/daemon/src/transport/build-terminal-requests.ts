import type { DaemonAnswer, RequestParams } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import { match } from 'ts-pattern';
import type { DaemonContext } from '../daemon-context';
import type { RequestDeps } from './request-deps';

// The requests that drive a session's terminal: attaching to it, typing
// into it, resizing it, and answering its menus and permission prompts.
export interface TerminalRequests {
  readonly applyAttach: (
    data: RequestParams<'session.attach'>,
    ctx: DaemonContext,
  ) => DaemonAnswer<'session.attach'>;

  readonly applyWatch: (
    data: RequestParams<'session.watch'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'session.watch'>>;

  readonly applyInput: (
    data: RequestParams<'session.input'>,
    ctx: DaemonContext,
  ) => DaemonAnswer<'session.input'>;

  readonly applySubmit: (
    data: RequestParams<'session.submit'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'session.submit'>>;

  // A read rejects with a DaemonError when the menu changes or ignores a key. The session
  // can leave the caller's view while the read runs, so its view is checked again before
  // the menu goes out.
  readonly applySessionMenu: (
    data: RequestParams<'session.menu'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'session.menu'>>;

  // A choice whose menu, label, or cursor does not match the screen rejects
  // with its DaemonError, which answers with that error's code.
  readonly applySessionChoose: (
    data: RequestParams<'session.choose'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'session.choose'>>;

  readonly applyResize: (
    data: RequestParams<'session.resize'>,
    ctx: DaemonContext,
  ) => DaemonAnswer<'session.resize'>;

  readonly applyPermissionRespond: (
    data: RequestParams<'permission.respond'>,
    ctx: DaemonContext,
  ) => DaemonAnswer<'permission.respond'>;
}

export function buildTerminalRequests(deps: RequestDeps): TerminalRequests {
  const client = deps.client;

  return {
    applyAttach: (data, ctx) => {
      const sessionID = data.session;
      const result = ctx.attachSession(client, sessionID, { cols: data.cols, rows: data.rows });

      if (result === 'missing') {
        throw new DaemonError('no_such_session', `no session '${sessionID}'`);
      }

      if (result === 'dead') {
        throw new DaemonError('session_dead', `session '${sessionID}' has no live process`);
      }

      const dims = ctx.getEffectiveDims(sessionID);

      return { cols: dims.cols, rows: dims.rows };
    },

    applyWatch: async (data, ctx) => {
      const sessionID = data.session;

      const result = await ctx.watchSession(client, sessionID);

      if (result === 'missing') {
        throw new DaemonError('no_such_session', `no session '${sessionID}'`);
      }

      if (result === 'dead') {
        throw new DaemonError('session_dead', `session '${sessionID}' has no live process`);
      }

      return { ...result };
    },

    applyInput: (data, ctx) => {
      requireInputResult(data.session, ctx.writeSessionInput(data.session, data.data));

      return {};
    },

    applySubmit: async (data, ctx) => {
      const result = await ctx.writeSessionLine(data.session, data.text);

      requireInputResult(data.session, result);

      return {};
    },

    applySessionMenu: async (data, ctx) => {
      const id = data.session;

      if (!ctx.isSessionVisible(id)) {
        throw new DaemonError('no_such_session', `no session '${id}'`);
      }

      const menu = await ctx.readSessionMenu(id);

      if (menu === 'missing' || !ctx.isSessionVisible(id)) {
        throw new DaemonError('no_such_session', `no session '${id}'`);
      }

      if (menu === 'no_screen') {
        throw new DaemonError('session_dead', `session '${id}' has no captured screen`);
      }

      if (menu === 'unsupported') {
        throw new DaemonError('unsupported', `atc cannot read the menus in session '${id}'`);
      }

      return { menu };
    },

    applySessionChoose: async (data, ctx) => {
      const id = data.session;
      const menuToken = data.menuToken;

      if (!ctx.isSessionVisible(id)) {
        throw new DaemonError('no_such_session', `no session '${id}'`);
      }

      const choice =
        data.key === 'escape'
          ? { menuToken, key: data.key }
          : { menuToken, option: data.option ?? 0, label: data.label ?? '' };

      const result = await ctx.applySessionMenuChoice(id, choice);

      if (result === 'missing') {
        throw new DaemonError('no_such_session', `no session '${id}'`);
      }

      if (result === 'dead') {
        throw new DaemonError('session_dead', `session '${id}' has no live process`);
      }

      if (result === 'unsupported') {
        throw new DaemonError('unsupported', `atc cannot read the menus in session '${id}'`);
      }

      return { ...result };
    },

    applyResize: (data, ctx) => {
      const sessionID = data.session;

      if (!ctx.resizeSession(client, sessionID, { cols: data.cols, rows: data.rows })) {
        throw new DaemonError('bad_args', `not attached to session '${sessionID}'`);
      }

      return {};
    },

    applyPermissionRespond: (data, ctx) => {
      const request = data.request;
      const result = ctx.answerPermission(request, data.decision);

      match(result)
        .with('ok', () => {})
        .with('already_answered', () => {
          throw new DaemonError('already_answered', `request '${request}' was already answered`);
        })
        .with('unsupported', () => {
          throw new DaemonError('unsupported', `request '${request}' is answered with keystrokes`);
        })
        .with('unknown', () => {
          throw new DaemonError('bad_args', `unknown permission request '${request}'`);
        })
        .exhaustive();

      return {};
    },
  };
}

// Text typed into a session goes through only when the session is live,
// idle, and shows no permission prompt.
function requireInputResult(
  sessionID: SessionID,
  result: 'busy' | 'ok' | 'missing' | 'dead' | 'permission_pending',
): void {
  match(result)
    .with('ok', () => {})
    .with('permission_pending', () => {
      throw new DaemonError(
        'permission_pending',
        `session '${sessionID}' is waiting on a permission prompt, where typed text picks the highlighted option; answer the prompt's menu with session.choose or in the atc TUI`,
      );
    })
    .with('missing', () => {
      throw new DaemonError('no_such_session', `no session '${sessionID}'`);
    })
    .with('dead', () => {
      throw new DaemonError('session_dead', `session '${sessionID}' has no live process`);
    })
    .with('busy', () => {
      throw new DaemonError(
        'too_slow',
        `session '${sessionID}' is mid-run; wait for the turn to end`,
      );
    })
    .exhaustive();
}
