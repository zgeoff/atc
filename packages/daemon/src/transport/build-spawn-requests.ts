import { basename, isAbsolute } from 'node:path';
import type { AgentID } from '@atc/core';
import type { SourceInputRequest, SourceProvider } from '@atc/plugin-api';
import { CONTROL_CHARACTER, parseDeclaredScope } from '@atc/protocol';
import type { DaemonAnswer, DeclaredScope, RequestParams } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import { toSessionID } from '@atcx/contract';
import { buildTargetForbiddenError } from '../auth/build-target-forbidden-error';
import { parseSpawnOverrides } from '../sessions/parse-spawn-overrides';
import type { DaemonContext, SpawnParams } from '../types';
import { buildKeyedRequest } from './build-keyed-request';
import type { RequestDeps } from './request-deps';

interface SourceParams {
  readonly source: string;
  readonly target?: string | undefined;
  readonly clientCwd?: string | undefined;
}

interface ResolvedSourceRequest {
  readonly source: SourceProvider;
  readonly request: SourceInputRequest;
}

export interface SpawnRequests {
  readonly applySpawn: (
    data: RequestParams<'session.spawn'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'session.spawn'>>;

  readonly applySourcesList: (
    data: RequestParams<'sources.list'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'sources.list'>>;

  readonly applySourcesInterpret: (
    data: RequestParams<'sources.interpret'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'sources.interpret'>>;

  readonly applySourcesComplete: (
    data: RequestParams<'sources.complete'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'sources.complete'>>;

  readonly applyGitProbe: (
    data: RequestParams<'git.probe'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'git.probe'>>;
}

export function buildSpawnRequests(deps: RequestDeps): SpawnRequests {
  const daemonContext = deps.ctx;

  const resolveSourceRequest = (
    params: SourceParams,
    ctx: DaemonContext,
  ): ResolvedSourceRequest => {
    const source = ctx.findSource(params.source);

    if (source === null) {
      throw new DaemonError('unsupported', `this daemon offers no source '${params.source}'`);
    }

    const target = ctx.resolveSpawnTarget(params.target);

    if (source.kind === 'git') {
      daemonContext.requireWorkspaceTarget(target);
    }

    return {
      source,
      request: {
        target,
        readSpawnDirs: () => ctx.readSpawnDirs(null),
        ...(params.clientCwd === undefined ? {} : { clientCwd: params.clientCwd }),
      },
    };
  };

  return {
    applySpawn: (data, ctx) => applySpawn(data, ctx, deps.identity.callerSession),

    applySourcesList: async (data, ctx) => {
      const resolved = resolveSourceRequest(data, ctx);
      const source = resolved.source;

      const listed = await source.list(
        {
          ...(data.scope === undefined ? {} : { scope: data.scope }),
          ...(data.text === undefined ? {} : { text: data.text }),
        },
        resolved.request,
      );

      return { source: source.id, scope: listed.scope, candidates: listed.candidates };
    },

    applySourcesInterpret: async (data, ctx) => {
      const resolved = resolveSourceRequest(data, ctx);

      return { ...(await resolved.source.interpret(data.input, resolved.request)) };
    },

    applySourcesComplete: async (data, ctx) => {
      const resolved = resolveSourceRequest(data, ctx);

      const completions = await resolved.source.complete?.(data.input, resolved.request);

      return { completions: completions ?? [] };
    },

    applyGitProbe: async (data, ctx) => {
      daemonContext.requireWorkspaceTarget(ctx.resolveSpawnTarget(data.target));

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

      return { url: access.url, head: access.head, refs: access.refs, resolved: access.resolved };
    },
  };
}

async function applySpawn(
  data: RequestParams<'session.spawn'>,
  ctx: DaemonContext,
  spawner: SessionID | null,
): Promise<DaemonAnswer<'session.spawn'>> {
  const cwd = data.cwd;

  if (cwd === undefined && data.workspace?.kind !== 'git') {
    throw new DaemonError('bad_args', 'session.spawn requires a cwd');
  }

  // Every refusal must be thrown while the key is being claimed. A retry of a held key answers
  // from the key without any check, and a refused spawn drops its claim.
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

    const remote = ctx
      .collectAgents()
      .targets.some((candidate) => candidate.id === target && candidate.remote);

    if (adapter.profile !== undefined && !entry.installed && !remote) {
      throw new DaemonError(
        'unsupported',
        `agent '${agent}' is registered but not installed on this host`,
      );
    }

    const refusal = adapter.findSpawnRefusal?.() ?? null;

    if (refusal !== null) {
      throw refusal;
    }

    ctx.requireAgentTarget(agent, target);

    const overrides = parseSpawnOverrides(entry, {
      model: data.model,
      effort: data.effort,
      pluginDirs: data.pluginDirs,
    });

    if (!overrides.ok) {
      throw new DaemonError(overrides.code, overrides.message);
    }

    const pluginDirs = ctx.requirePluginDirs(
      target,
      adapter.profile?.pluginDirs ?? [],
      overrides.overrides.pluginDirs ?? [],
    );

    if (data.workspace !== undefined) {
      ctx.requireWorkspaceTarget(target);
    }

    const directory =
      cwd === undefined && data.workspace?.kind === 'git'
        ? ctx.buildDefaultWorkspaceDir(target, data.workspace)
        : cwd;

    if (directory === undefined) {
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
    if (data.workspace !== undefined && !isPlainWorkspaceDir(directory)) {
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

    const atcAccess = data.atcAccess ?? [];

    ctx.requireGrantedSpawn({
      atcAccess,
      resume: data.resume,
      hasWorkspace: data.workspace !== undefined,
    });

    return {
      cwd: directory,
      name: data.name === '' ? basename(directory) : data.name,
      prompt: data.prompt,
      cols: data.cols,
      rows: data.rows,
      resume: data.resume,
      namedBy: data.name === '' ? 'auto' : 'user',
      agent,
      parent,
      spawner,
      atcAccess: atcAccess.length === 0 ? null : atcAccess,
      overrides: {
        ...overrides.overrides,
        ...(pluginDirs.length === 0 ? {} : { pluginDirs }),
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
    throw new DaemonError('bad_args', 'replayOnly needs an idempotencyKey');
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

  return spawned;
}

function isPlainWorkspaceDir(directory: string): boolean {
  return (
    !CONTROL_CHARACTER.test(directory) &&
    !directory.split('/').some((part) => part === '.' || part === '..')
  );
}

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
