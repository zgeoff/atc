import { basename, isAbsolute } from 'node:path';
import type { AgentID, SessionID } from '@atc/core';
import { toSessionID } from '@atc/core';
import type { SourceProvider, SourceRequest } from '@atc/plugin-api';
import { CONTROL_CHARACTER, parseDeclaredScope, parseRequestParams } from '@atc/protocol';
import type { DeclaredScope } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import type { RequestMsg } from '@atc/protocol/wire';
import { buildTargetForbiddenError } from '../auth/build-target-forbidden-error';
import type { DaemonContext, SpawnParams } from '../daemon-context';
import { parseSpawnOverrides } from '../sessions/parse-spawn-overrides';
import { buildKeyedRequest } from './build-keyed-request';
import type { ConnectionReply } from './connection-reply';
import type { RequestDeps } from './request-deps';

// What a source request holds: the source's id and the target it is for.
interface SourceParams {
  readonly source: string;
  readonly target?: string | undefined;
}

// The source a request asks for, and the request the source serves.
interface ResolvedSourceRequest {
  readonly source: SourceProvider;
  readonly request: SourceRequest;
}

// The requests that spawn a session and the source and git requests that
// prepare a spawn.
export class SpawnRequests {
  private readonly ctx: DaemonContext;

  private readonly reply: ConnectionReply;

  constructor(deps: RequestDeps) {
    this.ctx = deps.ctx;
    this.reply = deps.reply;
  }

  async applySpawn(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.spawn', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const data = parsed.data;
    const cwd = data.cwd;

    if (cwd === undefined && data.workspace?.kind !== 'git') {
      this.reply.sendErr(req.id, 'bad_args', 'session.spawn requires a cwd');

      return;
    }

    // Every refusal is thrown from the plan, which runs only once a key is
    // claimed: a retry of a held key answers from the key without checking
    // anything again, and a refused spawn drops its claim.
    const plan = (): SpawnParams => {
      // The target goes first: a config or target problem is the cause a
      // spawn reports, ahead of any agent check that problem can skew.
      const target = ctx.resolveSpawnTarget(data.target);
      const agent: AgentID = data.agent ?? ctx.collectAgents().spawnDefaults.agent;
      const adapter = ctx.findAdapter(agent);
      const entry = ctx.collectAgents().agents.find((candidate) => candidate.id === agent);

      if (adapter === null || entry === undefined) {
        throw new DaemonError('unsupported', `no adapter for agent '${agent}'`);
      }

      // A stand-in adapter declares no binary to check, so only a profiled
      // agent's missing binary refuses the spawn, and only on a target whose
      // provider runs the agent on the daemon's machine.
      const remote = ctx
        .collectAgents()
        .targets.some((candidate) => candidate.id === target && candidate.remote);

      if (adapter.profile !== undefined && !entry.installed && !remote) {
        throw new DaemonError(
          'unsupported',
          `agent '${agent}' is registered but not installed on this host`,
        );
      }

      // Checked before any workspace is materialized for the spawn.
      const refusal = adapter.findSpawnRefusal?.() ?? null;

      if (refusal !== null) {
        throw refusal;
      }

      ctx.requireAgentTarget(agent, target);

      const overrides = parseSpawnOverrides(entry, { model: data.model, effort: data.effort });

      if (!overrides.ok) {
        throw new DaemonError(overrides.code, overrides.message);
      }

      // Checked before the spawn starts, so a target that cannot take a
      // workspace refuses it before any git command runs.
      if (data.workspace !== undefined) {
        ctx.requireWorkspaceTarget(target);
      }

      // A git workspace without a cwd lands where the daemon picks on the
      // target.
      const dir =
        cwd === undefined && data.workspace?.kind === 'git'
          ? ctx.buildDefaultWorkspaceDir(target, data.workspace)
          : cwd;

      if (dir === undefined) {
        throw new DaemonError('bad_args', 'session.spawn requires a cwd');
      }

      // A workspace is materialized at cwd on the target, which only an
      // absolute path names; a directory the daemon picks on a remote
      // target is relative to the home there, which the host resolves.
      if (data.workspace !== undefined && cwd !== undefined && !isAbsolute(cwd)) {
        throw new DaemonError('bad_args', 'a spawn with a workspace requires an absolute cwd');
      }

      // A workspace is created, filled, and removed at the one directory
      // the host resolves cwd to, which a dot segment or a control
      // character would make differ from the path as written.
      if (data.workspace !== undefined && !isPlainWorkspaceDir(dir)) {
        throw new DaemonError(
          'bad_args',
          'a spawn with a workspace requires a cwd without . or .. segments or control characters',
        );
      }

      let parent: SessionID | null = null;

      if (data.parent !== undefined) {
        const resolved = ctx.resolveSpawnParent(data.parent);

        if (resolved === 'missing') {
          throw new DaemonError('no_such_session', `no session '${data.parent}'`);
        }

        parent = resolved;
      }

      return {
        cwd: dir,
        name: data.name === '' ? basename(dir) : data.name,
        prompt: data.prompt,
        cols: data.cols,
        rows: data.rows,
        resume: data.resume,
        namedBy: data.name === '' ? 'auto' : 'user',
        agent,
        parent,
        overrides: {
          ...overrides.overrides,
          ...(data.trustClonedWorkspace === undefined
            ? {}
            : { trustClonedWorkspace: data.trustClonedWorkspace }),
        },
        target,
        workspace: data.workspace ?? null,
        autoDir: cwd === undefined,
        scope: requireDeclaredScope(data.scope),
      };
    };

    if (data.replayOnly === true && data.idempotencyKey === undefined) {
      this.reply.sendErr(req.id, 'bad_args', 'replayOnly needs an idempotencyKey');

      return;
    }

    const keyed = buildKeyedRequest(data);

    const spawned = await ctx.spawnSession(plan, keyed, null);

    const sessionID = toSessionID(spawned.session.id);
    const grant = ctx.findSessionGrant(sessionID);

    // A live session whose tree left the view before the answer goes out gets the refusal a
    // replay out of reach gets; a replayed session no longer live was checked against its
    // fleet row by the replay itself.
    if (grant !== null && !ctx.isSessionVisible(sessionID)) {
      throw buildTargetForbiddenError(grant.target);
    }

    this.reply.sendOk(req.id, 'session.spawn', spawned);
  }

  // Lists one source's candidates for a spawn to the request's target.
  async applySourcesList(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('sources.list', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const resolved = this.resolveSourceRequest(parsed.data, ctx);
    const source = resolved.source;

    const listed = await source.list(
      {
        ...(parsed.data.scope === undefined ? {} : { scope: parsed.data.scope }),
        ...(parsed.data.text === undefined ? {} : { text: parsed.data.text }),
      },
      resolved.request,
    );

    this.reply.sendOk(req.id, 'sources.list', {
      source: source.id,
      scope: listed.scope,
      candidates: listed.candidates,
    });
  }

  // Reads typed input through one source for a spawn to the request's
  // target.
  async applySourcesInterpret(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('sources.interpret', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const resolved = this.resolveSourceRequest(parsed.data, ctx);

    const interpretation = await resolved.source.interpret(parsed.data.input, resolved.request);

    this.reply.sendOk(req.id, 'sources.interpret', { ...interpretation });
  }

  // The source a request asks for and the request it serves, so a principal
  // reaches a source only for a target it may spawn on, and a git source
  // only for a target it may spawn a workspace on.
  private resolveSourceRequest(params: SourceParams, ctx: DaemonContext): ResolvedSourceRequest {
    const source = ctx.findSource(params.source);

    if (source === null) {
      throw new DaemonError('unsupported', `this daemon offers no source '${params.source}'`);
    }

    const target = ctx.resolveSpawnTarget(params.target);

    if (source.kind === 'git') {
      this.ctx.requireWorkspaceTarget(target);
    }

    // The spawn history is read through the request's own view, so a
    // principal lists only directories spawned on targets it may use.
    return { source, request: { target, collectSpawnDirs: () => ctx.collectSpawnDirs(null) } };
  }

  // Probes a git workspace source for a spawn to the request's target, so
  // a principal probes only for a target it may spawn a workspace on. A
  // refusal holds the repository's other URLs that the offered sources know.
  async applyGitProbe(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('git.probe', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const data = parsed.data;

    this.ctx.requireWorkspaceTarget(ctx.resolveSpawnTarget(data.target));

    const access = await ctx.checkRepositoryAccess({
      url: data.url,
      ref: data.ref,
      sha: data.sha,
      credential: data.credentialRef,
    });

    if (!access.ok) {
      const alternates = ctx.collectAlternateGitURLs(data.url);
      const detail = alternates.length === 0 ? undefined : { alternates };

      throw new DaemonError(access.code, access.message, detail);
    }

    this.reply.sendOk(req.id, 'git.probe', {
      url: access.url,
      head: access.head,
      refs: access.refs,
      resolved: access.resolved,
    });
  }
}

function isPlainWorkspaceDir(dir: string): boolean {
  return (
    !CONTROL_CHARACTER.test(dir) && !dir.split('/').some((part) => part === '.' || part === '..')
  );
}

// A spawn without a scope declares none; one whose scope does not read
// refuses before anything starts, with the entry at fault.
function requireDeclaredScope(raw: unknown): DeclaredScope | null {
  if (raw === undefined) {
    return null;
  }

  const parsed = parseDeclaredScope(raw);

  if (!parsed.ok) {
    throw new DaemonError('scope_invalid', parsed.message, { entry: parsed.entry });
  }

  return parsed.scope;
}
