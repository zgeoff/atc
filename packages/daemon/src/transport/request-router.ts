import type { SessionID } from '@atc/core';
import { REQUEST_PARAM_SCHEMAS, parseDeclaredScope, parseRequestParams } from '@atc/protocol';
import type { RequestMethod } from '@atc/protocol';
import type { RequestMsg } from '@atc/protocol/wire';
import type { DaemonContext, OutputClient } from '../daemon-context';
import type { ConnectionReply } from './connection-reply';
import { MessageRequests } from './message-requests';
import { ReadRequests } from './read-requests';
import type { ConnectionIdentity, RequestDeps } from './request-deps';
import { SpawnRequests } from './spawn-requests';
import { TerminalRequests } from './terminal-requests';

// Answers each request a connection admits, by its method.
export class RequestRouter {
  private readonly client: OutputClient;

  private readonly reply: ConnectionReply;

  private readonly identity: ConnectionIdentity;

  private readonly spawn: SpawnRequests;

  private readonly terminal: TerminalRequests;

  private readonly reads: ReadRequests;

  private readonly messages: MessageRequests;

  constructor(deps: RequestDeps) {
    this.client = deps.client;
    this.reply = deps.reply;
    this.identity = deps.identity;

    this.spawn = new SpawnRequests(deps);
    this.terminal = new TerminalRequests(deps);
    this.reads = new ReadRequests(deps);
    this.messages = new MessageRequests(deps);
  }

  async applyRequest(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    if (!isRequestMethod(req.m)) {
      this.reply.sendErr(req.id, 'unknown_method', `unknown method '${req.m}'`);

      return;
    }

    switch (req.m) {
      case 'daemon.ping': {
        this.reply.sendOk(req.id, 'daemon.ping', {});

        return;
      }
      case 'session.list': {
        this.reply.sendOk(req.id, 'session.list', { sessions: ctx.collectSessions() });

        return;
      }
      case 'agents.list': {
        this.reply.sendOk(req.id, 'agents.list', { ...ctx.collectAgents() });

        return;
      }
      case 'dirs.list': {
        this.reply.sendOk(req.id, 'dirs.list', { dirs: await ctx.collectSpawnDirs(null) });

        return;
      }
      case 'fleet.list': {
        const fleet = await ctx.collectFleet();

        this.reply.sendOk(req.id, 'fleet.list', {
          fleet: fleet.filter((entry) => ctx.isSessionVisible(entry.sessionID)),
        });

        return;
      }
      case 'sources.list': {
        await this.spawn.applySourcesList(req, ctx);

        return;
      }
      case 'sources.interpret': {
        await this.spawn.applySourcesInterpret(req, ctx);

        return;
      }
      case 'git.probe': {
        await this.spawn.applyGitProbe(req, ctx);

        return;
      }
      case 'session.spawn': {
        await this.spawn.applySpawn(req, ctx);

        return;
      }
      case 'daemon.quit': {
        this.reply.sendOk(req.id, 'daemon.quit', {});
        ctx.quitDaemon();

        return;
      }
      case 'daemon.backup': {
        const parsed = parseRequestParams('daemon.backup', req.p);

        if (!parsed.ok) {
          this.reply.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        this.reply.sendOk(req.id, 'daemon.backup', {
          path: parsed.data.path,
          bytes: await ctx.writeStateBackup(parsed.data.path),
        });

        return;
      }
      case 'session.update': {
        const parsed = parseRequestParams('session.update', req.p);

        if (!parsed.ok) {
          this.reply.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const sessionID = parsed.data.session;

        const updated = ctx.updateSession(sessionID, {
          ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
          ...(parsed.data.pinned === undefined ? {} : { pinned: parsed.data.pinned }),
          ...(parsed.data.parent === null ? { parent: null } : {}),
        });

        if (updated === 'shared_host') {
          this.reply.sendErr(
            req.id,
            'bad_args',
            `session '${sessionID}' runs in its parent's host and cannot be detached from it or pinned apart from it`,
          );
        } else if (updated === 'agent_named') {
          this.reply.sendOk(req.id, 'session.update', { renameSkipped: 'agent_named' });
        } else if (updated) {
          this.reply.sendOk(req.id, 'session.update', {});
        } else {
          this.reply.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);
        }

        return;
      }
      case 'session.scope.add': {
        await this.applyScopeAdd(req, ctx);

        return;
      }
      case 'session.kill': {
        await this.applyKill(req, ctx);

        return;
      }
      case 'session.ack': {
        await this.applySessionVerb(req, 'session.ack', ctx.ackSession);

        return;
      }
      case 'session.forget': {
        const parsed = parseRequestParams('session.forget', req.p);

        if (!parsed.ok) {
          this.reply.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const id = parsed.data.session;

        const forgotten = await ctx.forgetSession(
          id,
          parsed.data.confirmToken,
          { pinned: parsed.data.refusePinned === true, live: parsed.data.refuseLive === true },
          this.identity.callerSession,
        );

        if (forgotten === 'missing') {
          this.reply.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        } else {
          this.reply.sendOk(req.id, 'session.forget', { ...forgotten });
        }

        return;
      }
      case 'session.auth.revoke': {
        const parsed = parseRequestParams('session.auth.revoke', req.p);

        if (!parsed.ok) {
          this.reply.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const id = parsed.data.session;

        const revoked = await ctx.revokeSessionAuth(id);

        if (revoked) {
          this.reply.sendOk(req.id, 'session.auth.revoke', { revoked: true });
        } else {
          this.reply.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        }

        return;
      }
      case 'session.auth.rebind': {
        const parsed = parseRequestParams('session.auth.rebind', req.p);

        if (!parsed.ok) {
          this.reply.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const id = parsed.data.session;

        const rebound = await ctx.updateSessionAuth(id);

        if (rebound === null) {
          this.reply.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        } else {
          this.reply.sendOk(req.id, 'session.auth.rebind', { ...rebound });
        }

        return;
      }
      case 'session.resumeCommand': {
        const parsed = parseRequestParams('session.resumeCommand', req.p);

        if (!parsed.ok) {
          this.reply.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const id = parsed.data.session;
        const resume = ctx.buildResumeCommand(id);

        if ('command' in resume) {
          this.reply.sendOk(req.id, 'session.resumeCommand', { command: resume.command });
        } else if (resume.refusal === 'missing') {
          this.reply.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        } else {
          this.reply.sendErr(req.id, 'unsupported', resume.reason);
        }

        return;
      }
      case 'session.screen': {
        const parsed = parseRequestParams('session.screen', req.p);

        if (!parsed.ok) {
          this.reply.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const id = parsed.data.session;

        const screen = await ctx.readSessionScreen(id);

        if (screen === 'missing' || !ctx.isSessionVisible(id)) {
          this.reply.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        } else if (screen === 'no_screen') {
          this.reply.sendErr(req.id, 'session_dead', `session '${id}' has no captured screen`);
        } else {
          this.reply.sendOk(req.id, 'session.screen', { ...screen });
        }

        return;
      }
      case 'session.menu': {
        this.terminal.applySessionMenu(req, ctx);

        return;
      }
      case 'session.choose': {
        this.terminal.applySessionChoose(req, ctx);

        return;
      }
      case 'session.eject': {
        const parsed = parseRequestParams('session.eject', req.p);

        if (!parsed.ok) {
          this.reply.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const sessionID = parsed.data.session;
        const result = ctx.ejectSession(sessionID, parsed.data.prompt);

        if (result === 'ok') {
          this.reply.sendOk(req.id, 'session.eject', {});
        } else if (result === 'unsupported') {
          this.reply.sendErr(req.id, 'unsupported', "this session's agent has no headless handoff");
        } else if (result === 'no_transcript') {
          this.reply.sendNoTranscript(req.id);
        } else {
          this.reply.sendErr(
            req.id,
            'no_such_session',
            `session '${sessionID}' has no live terminal with a captured agent session id`,
          );
        }

        return;
      }
      case 'session.adopt': {
        const parsed = parseRequestParams('session.adopt', req.p);

        if (!parsed.ok) {
          this.reply.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const sessionID = parsed.data.session;

        const adoptResult = await ctx.adoptSession(
          sessionID,
          parsed.data.cols,
          parsed.data.rows,
          null,
        );

        if (adoptResult === 'ok') {
          this.reply.sendOk(req.id, 'session.adopt', {});
        } else if (adoptResult === 'no_transcript') {
          this.reply.sendNoTranscript(req.id);
        } else {
          this.reply.sendErr(
            req.id,
            'no_such_session',
            `session '${sessionID}' is not a dead or headless session with a captured agent session id`,
          );
        }

        return;
      }
      case 'session.attach': {
        this.terminal.applyAttach(req, ctx);

        return;
      }
      case 'session.detach': {
        const parsed = parseRequestParams('session.detach', req.p);

        if (!parsed.ok) {
          this.reply.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        ctx.detachSession(this.client, parsed.data.session);
        this.reply.sendOk(req.id, 'session.detach', {});

        return;
      }
      case 'session.input': {
        this.terminal.applyInput(req, ctx);

        return;
      }
      case 'session.submit': {
        await this.terminal.applySubmit(req, ctx);

        return;
      }
      case 'session.resize': {
        this.terminal.applyResize(req, ctx);

        return;
      }
      case 'permission.respond': {
        this.terminal.applyPermissionRespond(req, ctx);

        return;
      }
      case 'session.message': {
        await this.messages.applySessionMessage(req, ctx);

        return;
      }
      case 'session.tap': {
        this.messages.applyTap(req, ctx);

        return;
      }
      case 'message.get': {
        await this.messages.applyMessageGet(req, ctx);

        return;
      }
      case 'message.ack': {
        await this.messages.applyMessageAck(req, ctx);

        return;
      }
      case 'notice.ack': {
        await this.messages.applyNoticeAck(req, ctx);

        return;
      }
      case 'fleet.restore': {
        const parsed = parseRequestParams('fleet.restore', req.p);

        if (!parsed.ok) {
          this.reply.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        this.reply.sendOk(req.id, 'fleet.restore', {
          restored: await ctx.restoreFleet(parsed.data.cols, parsed.data.rows),
        });

        return;
      }
      case 'session.get': {
        await this.reads.applySessionGet(req, ctx);

        return;
      }
      case 'session.read': {
        await this.reads.applySessionRead(req, ctx);

        return;
      }
      case 'events.read': {
        await this.reads.applyEventsRead(req, ctx);

        return;
      }
      case 'note.get': {
        await this.reads.applyNoteGet(req, ctx);

        return;
      }
      case 'answer.get': {
        await this.reads.applyAnswerGet(req, ctx);

        return;
      }

      // The handshake is answered before a request is admitted, so it never
      // runs as one.
      case 'daemon.hello': {
        this.reply.sendErr(req.id, 'unknown_method', `unknown method '${req.m}'`);
      }
    }
  }

  // A client inside a session never adds to the record of that session or
  // of a session it is a sub-session of: only a caller outside the tree
  // vouches for what the session may touch.
  private async applyScopeAdd(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.scope.add', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;
    const declared = parseDeclaredScope(parsed.data.scope);

    if (!declared.ok) {
      this.reply.sendErr(req.id, 'scope_invalid', declared.message, { entry: declared.entry });

      return;
    }

    if (
      this.identity.callerSession !== null &&
      ctx.isCallerTree(sessionID, this.identity.callerSession)
    ) {
      this.reply.sendErr(
        req.id,
        'unauthorized',
        `session '${this.identity.callerSession}' cannot add to the scope of session '${sessionID}': a session never widens its own scope or that of a session above it`,
      );

      return;
    }

    const record = await ctx.updateSessionScope(sessionID, declared.scope);

    if (record === 'missing') {
      this.reply.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    this.reply.sendOk(req.id, 'session.scope.add', { record });
  }

  private async applyKill(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.kill', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const stopOnly = parsed.data.stopOnly === true;

    const outcome = await ctx.killSession(parsed.data.session, stopOnly);

    if (outcome === 'missing') {
      this.reply.sendErr(req.id, 'no_such_session', `no session '${parsed.data.session}'`);

      return;
    }

    const answer = stopOnly ? { stopped: outcome === 'stopped' } : {};

    this.reply.sendOk(req.id, 'session.kill', answer);
  }

  private async applySessionVerb(
    req: RequestMsg,
    method: 'session.ack',
    verb: (id: SessionID) => boolean | Promise<boolean>,
  ): Promise<void> {
    const parsed = parseRequestParams(method, req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const id = parsed.data.session;

    const ok = await verb(id);

    if (ok) {
      this.reply.sendOk(req.id, method, {});
    } else {
      this.reply.sendErr(req.id, 'no_such_session', `no session '${id}'`);
    }
  }
}

function isRequestMethod(method: string): method is RequestMethod {
  return Object.hasOwn(REQUEST_PARAM_SCHEMAS, method);
}
