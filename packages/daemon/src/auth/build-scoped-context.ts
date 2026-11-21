import type { SessionID } from '@atcx/contract';
import { toSessionID } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';
import { pick } from '@zgeoff/std';
import type { KeyedRequest } from '../transport/create-idempotency-ledger';
import type { DaemonContext } from '../types';
import { buildGrantFromFleetEntry } from './build-grant-from-fleet-entry';
import type { TargetAccess, TargetGrant } from './build-target-access-from-grants';
import { buildTargetForbiddenError } from './build-target-forbidden-error';
import { CONTEXT_MEMBER_SCOPES } from './context-member-scopes';

type ContextMemberScopes = typeof CONTEXT_MEMBER_SCOPES;

type NarrowedMember = {
  [K in keyof ContextMemberScopes]: ContextMemberScopes[K] extends 'narrowed' ? K : never;
}[keyof ContextMemberScopes];

export function buildScopedContext(
  ctx: DaemonContext,
  access: TargetAccess,
  keyNamespace: string,
): DaemonContext {
  const buildPrincipalKey = (keyed: KeyedRequest | null): KeyedRequest | null =>
    keyed === null ? null : { ...keyed, principal: keyNamespace };

  const canSee = (id: SessionID): boolean => ctx.canSeeSession(id, access);

  const mergeAccess = (outer: TargetAccess | null): TargetAccess =>
    outer === null ? access : outer.merge(access);

  const canUseTarget = (target: string): boolean => {
    const targetIdentity = ctx.findTargetIdentity(target);

    return targetIdentity !== null && access.canUse({ target, targetIdentity });
  };

  const readGrant = async (id: SessionID): Promise<TargetGrant | null> => {
    const live = ctx.findSessionGrant(id);

    if (live !== null) {
      return live;
    }

    const fleet = await ctx.readFleet();

    const entry = fleet.find((row) => row.sessionID === id);

    if (entry === undefined) {
      return null;
    }

    return buildGrantFromFleetEntry(entry);
  };

  const requireSessionInReach = async (id: SessionID): Promise<void> => {
    const grant = await readGrant(id);

    if (grant !== null && !access.canUse(grant)) {
      throw buildTargetForbiddenError(grant.target);
    }
  };

  const narrowed: Pick<DaemonContext, NarrowedMember> = {
    // A principal's token scopes live in the MCP server that vouches for it,
    // which refuses a scope the token lacks before the request leaves it.
    requireGrantedSpawn: () => {},
    isSessionVisible: canSee,
    collectSessions: () => ctx.collectSessions().filter((session) => canSee(session.id)),
    collectAgents: () => {
      const list = ctx.collectAgents();
      const defaultTarget = list.spawnDefaults.target;

      return {
        ...list,

        agents: list.agents.map((agent) => {
          const listedTargets = agent.spawnTargets;
          const usableTargets = listedTargets.filter((target) => canUseTarget(target));
          const spawn = usableTargets.length > 0;

          const takesPluginDirs = list.targets.some(
            (target) => !target.remote && usableTargets.includes(target.id),
          );

          const pluginDirs = agent.spawnOptions.pluginDirs;

          return {
            ...agent,
            spawnTargets: usableTargets,
            capabilities: { ...agent.capabilities, spawn },
            spawnOptions: {
              model: {
                ...agent.spawnOptions.model,
                available: spawn && agent.spawnOptions.model.supported,
              },
              effort: {
                ...agent.spawnOptions.effort,
                available: spawn && agent.spawnOptions.effort.supported,
              },
              pluginDirs: {
                ...pluginDirs,
                available: takesPluginDirs && pluginDirs.supported,
              },
            },
          };
        }),
        targets: list.targets.filter((target) => canUseTarget(target.id)),
        spawnDefaults: {
          ...list.spawnDefaults,
          target: defaultTarget !== null && canUseTarget(defaultTarget) ? defaultTarget : null,
        },

        // The config file's own problem holds a path on the daemon's host,
        // which is the owner's alone.
        targetErrors: list.targetErrors.filter((error) => {
          if (error.scope === 'config') {
            return false;
          }

          return error.target === undefined || canUseTarget(error.target);
        }),
      };
    },
    readSpawnDirs: (outer) => {
      const merged = outer === null ? access : outer.merge(access);

      return ctx.readSpawnDirs(merged);
    },
    resolveSpawnParent: (id) => (canSee(id) ? ctx.resolveSpawnParent(id) : 'missing'),
    resolveSpawnTarget: (requested) => {
      if (requested !== undefined) {
        requireTarget(canUseTarget, requested);
      }

      const target = ctx.resolveSpawnTarget(requested);

      requireTarget(canUseTarget, target);

      return target;
    },
    spawnSession: async (plan, keyed) => {
      try {
        return await ctx.spawnSession(plan, buildPrincipalKey(keyed), access);
      } catch (error) {
        if (error instanceof AtcError && typeof error.data?.['effectRef'] === 'string') {
          await requireSessionInReach(toSessionID(error.data['effectRef']));
        }

        throw error;
      }
    },

    // The daemon's kill takes the session's sub-sessions before its first
    // await, so the set it kills is the set this check saw.
    killSession: (id, stopOnly) =>
      canSee(id) ? ctx.killSession(id, stopOnly) : Promise.resolve('missing' as const),

    forgetSession: (id, confirmToken, refuse, caller) =>
      canSee(id)
        ? ctx.forgetSession(id, confirmToken, refuse, caller)
        : Promise.resolve('missing' as const),
    revokeSessionAuth: (id) => (canSee(id) ? ctx.revokeSessionAuth(id) : Promise.resolve(false)),
    updateSessionAuth: (id) => (canSee(id) ? ctx.updateSessionAuth(id) : Promise.resolve(null)),
    updateSession: (id, changes) => canSee(id) && ctx.updateSession(id, changes),
    updateSessionScope: (id, scope) =>
      canSee(id) ? ctx.updateSessionScope(id, scope) : Promise.resolve('missing' as const),
    ackSession: (id) => canSee(id) && ctx.ackSession(id),
    planResumeCommand: (id) =>
      canSee(id) ? ctx.planResumeCommand(id) : { refusal: 'missing' as const },
    readSessionScreen: (id) =>
      canSee(id) ? ctx.readSessionScreen(id) : Promise.resolve('missing' as const),
    readSessionMenu: (id) =>
      canSee(id) ? ctx.readSessionMenu(id) : Promise.resolve('missing' as const),
    applySessionMenuChoice: (id, choice) =>
      canSee(id) ? ctx.applySessionMenuChoice(id, choice) : Promise.resolve('missing' as const),
    answerPermission: (request, decision) => {
      const owner = ctx.findPermissionSession(request);

      return owner !== null && canSee(owner) ? ctx.answerPermission(request, decision) : 'unknown';
    },
    attachSession: (client, sessionID, dims, replay) =>
      canSee(sessionID) ? ctx.attachSession(client, sessionID, dims, replay) : 'missing',

    // A session can leave the caller's reach while its replay is captured,
    // such as when a sub-session on another target joins its tree, so the
    // reach is checked again before the replay leaves the daemon.
    watchSession: async (client, sessionID) => {
      if (!canSee(sessionID)) {
        return 'missing';
      }

      const watch = await ctx.watchSession(client, sessionID);

      if (typeof watch === 'object' && !canSee(sessionID)) {
        ctx.detachSession(client, sessionID);

        return 'missing';
      }

      return watch;
    },
    detachSession: (client, sessionID) => {
      if (canSee(sessionID)) {
        ctx.detachSession(client, sessionID);
      }
    },
    writeSessionInput: (sessionID, data) =>
      canSee(sessionID) ? ctx.writeSessionInput(sessionID, data) : 'missing',
    writeSessionLine: (sessionID, text) =>
      canSee(sessionID) ? ctx.writeSessionLine(sessionID, text) : Promise.resolve('missing'),
    ejectSession: (id, prompt) => (canSee(id) ? ctx.ejectSession(id, prompt) : 'missing'),
    adoptSession: (id, cols, rows, outer) =>
      canSee(id)
        ? ctx.adoptSession(id, cols, rows, mergeAccess(outer))
        : Promise.resolve('missing' as const),
    resizeSession: (client, sessionID, dims) =>
      canSee(sessionID) && ctx.resizeSession(client, sessionID, dims),
    readSessionRecord: (id, outer) =>
      canSee(id)
        ? ctx.readSessionRecord(id, mergeAccess(outer))
        : Promise.resolve('missing' as const),
    loadSessionTranscript: (id, from, limit) =>
      canSee(id) ? ctx.loadSessionTranscript(id, from, limit) : Promise.resolve('missing' as const),
    readEvents: (params) => {
      const merged = params.access === null ? access : params.access.merge(access);

      return ctx.readEvents({ ...params, access: merged });
    },
    readNote: (id, outer) => ctx.readNote(id, mergeAccess(outer)),
    readAnswer: (id, outer) => ctx.readAnswer(id, mergeAccess(outer)),
    writeSessionMessage: (params) =>
      canSee(params.sessionID)
        ? ctx.writeSessionMessage({
            ...params,
            keyed: buildPrincipalKey(params.keyed),
            access: mergeAccess(params.access),
          })
        : Promise.resolve('missing' as const),
    readMessage: async (messageID, waitMs) => {
      const view = await ctx.readMessage(messageID, 0);

      // Only the session the message was sent to owns it here, never one
      // that shares its agent session id.
      if (view === null || view.session !== view.record.atcID || !canSee(view.session)) {
        return null;
      }

      if (waitMs === 0) {
        return view;
      }

      // The message may move to another session that holds its agent
      // session id while the read waits.
      const waited = await ctx.readMessage(messageID, waitMs);

      return waited !== null && waited.session === waited.record.atcID ? waited : null;
    },
    attachTap: (client, sessionID, outer, notices) =>
      canSee(sessionID) ? ctx.attachTap(client, sessionID, mergeAccess(outer), notices) : 'missing',
    ackMessage: (client, sessionID, messageID, outer) =>
      canSee(sessionID)
        ? ctx.ackMessage(client, sessionID, messageID, mergeAccess(outer))
        : Promise.resolve('unknown' as const),
    ackNotice: (client, sessionID, messageID) =>
      canSee(sessionID)
        ? ctx.ackNotice(client, sessionID, messageID)
        : Promise.resolve('unknown' as const),
  };

  const shared = Object.keys(CONTEXT_MEMBER_SCOPES).filter((member) => isSharedMember(member));

  return { ...pick(ctx, shared), ...narrowed };
}

function requireTarget(canUseTarget: (target: string) => boolean, target: string): void {
  if (!canUseTarget(target)) {
    throw buildTargetForbiddenError(target);
  }
}

type SharedMember = Exclude<keyof DaemonContext, NarrowedMember>;

function isSharedMember(member: string): member is SharedMember {
  return isContextMember(member) && CONTEXT_MEMBER_SCOPES[member] !== 'narrowed';
}

function isContextMember(member: string): member is keyof DaemonContext {
  return Object.hasOwn(CONTEXT_MEMBER_SCOPES, member);
}
