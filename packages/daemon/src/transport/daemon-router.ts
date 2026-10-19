import type { SessionID } from '@atc/core';
import { DAEMON_CONTRACT, parseDeclaredScope } from '@atc/protocol';
import type { DaemonAnswer, RequestParams } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import { implement } from '@orpc/server';
import type { DaemonContext } from '../daemon-context';
import type { ProcedureContext } from './procedure-context';

const os = implement(DAEMON_CONTRACT).$context<ProcedureContext>();

// Answers each procedure a connection admits.
export const DAEMON_ROUTER = os.router({
  daemon: {
    // The handshake is answered before a request is admitted, so it never
    // runs as one.
    hello: os.daemon.hello.handler(() => {
      throw new DaemonError('unknown_method', "unknown method 'daemon.hello'");
    }),
    ping: os.daemon.ping.handler(() => ({})),
    quit: os.daemon.quit.handler((call) => {
      call.context.ctx.quitDaemon();

      return {};
    }),
    backup: os.daemon.backup.handler(async (call) => ({
      path: call.input.path,
      bytes: await call.context.ctx.writeStateBackup(call.input.path),
    })),
  },
  dirs: {
    list: os.dirs.list.handler(async (call) => ({
      dirs: await call.context.ctx.collectSpawnDirs(null),
    })),
  },
  agents: {
    list: os.agents.list.handler((call) => ({ ...call.context.ctx.collectAgents() })),
  },
  sources: {
    list: os.sources.list.handler((call) =>
      call.context.requests.spawn.applySourcesList(call.input, call.context.ctx),
    ),
    interpret: os.sources.interpret.handler((call) =>
      call.context.requests.spawn.applySourcesInterpret(call.input, call.context.ctx),
    ),
    complete: os.sources.complete.handler((call) =>
      call.context.requests.spawn.applySourcesComplete(call.input, call.context.ctx),
    ),
  },
  git: {
    probe: os.git.probe.handler((call) =>
      call.context.requests.spawn.applyGitProbe(call.input, call.context.ctx),
    ),
  },
  fleet: {
    list: os.fleet.list.handler(async (call) => {
      const ctx = call.context.ctx;

      const fleet = await ctx.collectFleet();

      return { fleet: fleet.filter((entry) => ctx.isSessionVisible(entry.sessionID)) };
    }),
    restore: os.fleet.restore.handler(async (call) => ({
      restored: await call.context.ctx.restoreFleet(call.input.cols, call.input.rows),
    })),
  },
  session: {
    list: os.session.list.handler((call) => ({ sessions: call.context.ctx.collectSessions() })),
    spawn: os.session.spawn.handler((call) =>
      call.context.requests.spawn.applySpawn(call.input, call.context.ctx),
    ),
    kill: os.session.kill.handler((call) => applyKill(call.input, call.context.ctx)),
    ack: os.session.ack.handler((call) => {
      if (!call.context.ctx.ackSession(call.input.session)) {
        throw new DaemonError('no_such_session', `no session '${call.input.session}'`);
      }

      return {};
    }),
    forget: os.session.forget.handler(async (call) => {
      const input = call.input;

      const forgotten = await call.context.ctx.forgetSession(
        input.session,
        input.confirmToken,
        { pinned: input.refusePinned === true, live: input.refuseLive === true },
        call.context.requests.identity.callerSession,
      );

      if (forgotten === 'missing') {
        throw new DaemonError('no_such_session', `no session '${input.session}'`);
      }

      return { ...forgotten };
    }),
    resumeCommand: os.session.resumeCommand.handler((call) => {
      const resume = call.context.ctx.buildResumeCommand(call.input.session);

      if ('command' in resume) {
        return { command: resume.command };
      }

      if (resume.refusal === 'missing') {
        throw new DaemonError('no_such_session', `no session '${call.input.session}'`);
      }

      throw new DaemonError('unsupported', resume.reason);
    }),
    auth: {
      revoke: os.session.auth.revoke.handler(async (call) => {
        if (!(await call.context.ctx.revokeSessionAuth(call.input.session))) {
          throw new DaemonError('no_such_session', `no session '${call.input.session}'`);
        }

        return { revoked: true as const };
      }),
      rebind: os.session.auth.rebind.handler(async (call) => {
        const rebound = await call.context.ctx.updateSessionAuth(call.input.session);

        if (rebound === null) {
          throw new DaemonError('no_such_session', `no session '${call.input.session}'`);
        }

        return { ...rebound };
      }),
    },
    update: os.session.update.handler((call) => applyUpdate(call.input, call.context.ctx)),
    scope: {
      add: os.session.scope.add.handler((call) =>
        applyScopeAdd(call.input, call.context.ctx, call.context.requests.identity.callerSession),
      ),
    },
    attach: os.session.attach.handler((call) =>
      call.context.requests.terminal.applyAttach(call.input, call.context.ctx),
    ),
    detach: os.session.detach.handler((call) => {
      call.context.ctx.detachSession(call.context.requests.client, call.input.session);

      return {};
    }),
    input: os.session.input.handler((call) =>
      call.context.requests.terminal.applyInput(call.input, call.context.ctx),
    ),
    submit: os.session.submit.handler((call) =>
      call.context.requests.terminal.applySubmit(call.input, call.context.ctx),
    ),
    resize: os.session.resize.handler((call) =>
      call.context.requests.terminal.applyResize(call.input, call.context.ctx),
    ),
    screen: os.session.screen.handler(async (call) => {
      const ctx = call.context.ctx;
      const id = call.input.session;

      const screen = await ctx.readSessionScreen(id);

      if (screen === 'missing' || !ctx.isSessionVisible(id)) {
        throw new DaemonError('no_such_session', `no session '${id}'`);
      }

      if (screen === 'no_screen') {
        throw new DaemonError('session_dead', `session '${id}' has no captured screen`);
      }

      return { ...screen };
    }),
    menu: os.session.menu.handler((call) =>
      call.context.requests.terminal.applySessionMenu(call.input, call.context.ctx),
    ),
    choose: os.session.choose.handler((call) =>
      call.context.requests.terminal.applySessionChoose(call.input, call.context.ctx),
    ),
    eject: os.session.eject.handler((call) => applyEject(call.input, call.context.ctx)),
    adopt: os.session.adopt.handler((call) => applyAdopt(call.input, call.context.ctx)),
    get: os.session.get.handler((call) =>
      call.context.requests.reads.applySessionGet(call.input, call.context.ctx),
    ),
    read: os.session.read.handler((call) =>
      call.context.requests.reads.applySessionRead(call.input, call.context.ctx),
    ),
    message: os.session.message.handler((call) =>
      call.context.requests.messages.applySessionMessage(
        call.input,
        call.context.ctx,
        call.context.as,
      ),
    ),
    tap: os.session.tap.handler((call) =>
      call.context.requests.messages.applyTap(call.input, call.context.ctx),
    ),
  },
  permission: {
    respond: os.permission.respond.handler((call) =>
      call.context.requests.terminal.applyPermissionRespond(call.input, call.context.ctx),
    ),
  },
  events: {
    read: os.events.read.handler((call) =>
      call.context.requests.reads.applyEventsRead(call.input, call.context.ctx),
    ),

    // The line protocol pushes events unasked, so it offers no subscription.
    subscribe: os.events.subscribe.handler(() => {
      throw new DaemonError('unknown_method', "unknown method 'events.subscribe'");
    }),
  },
  message: {
    get: os.message.get.handler((call) =>
      call.context.requests.messages.applyMessageGet(call.input, call.context.ctx),
    ),
    ack: os.message.ack.handler((call) =>
      call.context.requests.messages.applyMessageAck(call.input, call.context.ctx),
    ),
  },
  notice: {
    ack: os.notice.ack.handler((call) =>
      call.context.requests.messages.applyNoticeAck(call.input, call.context.ctx),
    ),
  },
  note: {
    get: os.note.get.handler((call) =>
      call.context.requests.reads.applyNoteGet(call.input, call.context.ctx),
    ),
  },
  answer: {
    get: os.answer.get.handler((call) =>
      call.context.requests.reads.applyAnswerGet(call.input, call.context.ctx),
    ),
  },
});

async function applyKill(
  input: RequestParams<'session.kill'>,
  ctx: DaemonContext,
): Promise<DaemonAnswer<'session.kill'>> {
  const stopOnly = input.stopOnly === true;

  const outcome = await ctx.killSession(input.session, stopOnly);

  if (outcome === 'missing') {
    throw new DaemonError('no_such_session', `no session '${input.session}'`);
  }

  return stopOnly ? { stopped: outcome === 'stopped' } : {};
}

function applyUpdate(
  input: RequestParams<'session.update'>,
  ctx: DaemonContext,
): DaemonAnswer<'session.update'> {
  const sessionID = input.session;

  const updated = ctx.updateSession(sessionID, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
    ...(input.parent === null ? { parent: null } : {}),
  });

  if (updated === 'shared_host') {
    throw new DaemonError(
      'bad_args',
      `session '${sessionID}' runs in its parent's host and cannot be detached from it or pinned apart from it`,
    );
  }

  if (updated === 'agent_named') {
    return { renameSkipped: 'agent_named' };
  }

  if (!updated) {
    throw new DaemonError('no_such_session', `no session '${sessionID}'`);
  }

  return {};
}

// A client inside a session never adds to the record of that session or
// of a session it is a sub-session of: only a caller outside the tree
// vouches for what the session may touch.
async function applyScopeAdd(
  input: RequestParams<'session.scope.add'>,
  ctx: DaemonContext,
  callerSession: SessionID | null,
): Promise<DaemonAnswer<'session.scope.add'>> {
  const sessionID = input.session;
  const declared = parseDeclaredScope(input.scope);

  if (!declared.ok) {
    throw new DaemonError('scope_invalid', declared.message, { entry: declared.entry });
  }

  if (callerSession !== null && ctx.isCallerTree(sessionID, callerSession)) {
    throw new DaemonError(
      'unauthorized',
      `session '${callerSession}' cannot add to the scope of session '${sessionID}': a session never widens its own scope or that of a session above it`,
    );
  }

  const record = await ctx.updateSessionScope(sessionID, declared.scope);

  if (record === 'missing') {
    throw new DaemonError('no_such_session', `no session '${sessionID}'`);
  }

  return { record };
}

function applyEject(
  input: RequestParams<'session.eject'>,
  ctx: DaemonContext,
): DaemonAnswer<'session.eject'> {
  const result = ctx.ejectSession(input.session, input.prompt);

  if (result === 'ok') {
    return {};
  }

  if (result === 'unsupported') {
    throw new DaemonError('unsupported', "this session's agent has no headless handoff");
  }

  if (result === 'no_transcript') {
    throw buildNoTranscriptError();
  }

  throw new DaemonError(
    'no_such_session',
    `session '${input.session}' has no live terminal with a captured agent session id`,
  );
}

async function applyAdopt(
  input: RequestParams<'session.adopt'>,
  ctx: DaemonContext,
): Promise<DaemonAnswer<'session.adopt'>> {
  const result = await ctx.adoptSession(input.session, input.cols, input.rows, null);

  if (result === 'ok') {
    return {};
  }

  if (result === 'no_transcript') {
    throw buildNoTranscriptError();
  }

  throw new DaemonError(
    'no_such_session',
    `session '${input.session}' is not a dead or headless session with a captured agent session id`,
  );
}

// A resume or adopt of a session whose agent saved no transcript yet.
function buildNoTranscriptError(): DaemonError {
  return new DaemonError(
    'session_dead',
    'nothing to resume yet — the session has no saved transcript',
  );
}
