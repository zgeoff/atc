import { DaemonError } from '../protocol/daemon-error';
import type { SessionID } from '../shared/session-id';
import { toSessionID } from '../shared/to-session-id';
import { buildGrantFromFleetEntry } from './build-grant-from-fleet-entry';
import { buildTargetForbiddenError } from './build-target-forbidden-error';
import type { DaemonContext } from './daemon-context';
import type { KeyedRequest } from './idempotency-ledger';
import type { TargetAccess, TargetGrant } from './target-access';

/**
 * The daemon as a principal with the given access sees it. Its keyed
 * spawns and messages hold their keys in the given namespace, apart from
 * every other namespace's. A session exists here only when the access
 * reaches every session in its tree: its top-level session and each
 * sub-session of that one. Every lookup of any other session answers as a
 * lookup of an unknown session does, so the request's own handling refuses
 * it with the words and data it gives a session that never existed. Lists
 * leave such sessions out, the directory list leaves out directories
 * spawned only on targets outside the access, and a spawn may use only a
 * target the access holds, a spawn's replayed answer included. A kill, a
 * forget, or a change checks the tree in the same synchronous step that
 * starts it, so a sub-session added after the check is never part of it.
 */
export function buildScopedContext(
  ctx: DaemonContext,
  access: TargetAccess,
  keyNamespace: string,
): DaemonContext {
  // A keyed request's key, held in this namespace alone.
  const buildPrincipalKey = (keyed: KeyedRequest | null): KeyedRequest | null =>
    keyed === null ? null : { ...keyed, principal: keyNamespace };

  const canSee = (id: SessionID): boolean => ctx.canSeeSession(id, access);

  // A request's own access narrowed to this one.
  const mergeAccess = (outer: TargetAccess | null): TargetAccess =>
    outer === null ? access : outer.merge(access);

  const canUseTarget = (target: string): boolean => {
    const targetIdentity = ctx.findTargetIdentity(target);

    return targetIdentity !== null && access.canUse({ target, targetIdentity });
  };

  // The target a session is bound to: the live session's, else its fleet
  // row's, else null for a session the daemon holds nowhere.
  const findGrant = async (id: SessionID): Promise<TargetGrant | null> => {
    const live = ctx.findSessionGrant(id);

    if (live !== null) {
      return live;
    }

    const fleet = await ctx.collectFleet();

    const entry = fleet.find((row) => row.sessionID === id);

    if (entry === undefined) {
      return null;
    }

    return buildGrantFromFleetEntry(entry);
  };

  // Throws the refusal a fresh spawn to the session's target gets when a
  // held key's refusal carries a session out of reach.
  const requireSessionInReach = async (id: SessionID): Promise<void> => {
    const grant = await findGrant(id);

    if (grant !== null && !access.canUse(grant)) {
      throw buildTargetForbiddenError(grant.target);
    }
  };

  return {
    ...ctx,
    isSessionVisible: canSee,
    collectSessions: () => ctx.collectSessions().filter((session) => canSee(session.id)),
    collectAgents: () => {
      const list = ctx.collectAgents();
      const defaultTarget = list.spawnDefaults.target;

      return {
        ...list,
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
    collectSpawnDirs: (outer) => {
      const merged = outer === null ? access : outer.merge(access);

      return ctx.collectSpawnDirs(merged);
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
      // A held key's replay is checked against the target its session was
      // bound to, inside the spawn, before its answer leaves the daemon.
      try {
        return await ctx.spawnSession(plan, buildPrincipalKey(keyed), access);
      } catch (error) {
        // A held key's refusal may carry the session its spawn made.
        if (error instanceof DaemonError && typeof error.data?.['effectRef'] === 'string') {
          await requireSessionInReach(toSessionID(error.data['effectRef']));
        }

        throw error;
      }
    },

    // The daemon's kill takes the session's sub-sessions before its first
    // await, so the set it kills is the set this check saw.
    killSession: (id) => (canSee(id) ? ctx.killSession(id) : Promise.resolve(false)),

    // A session out of reach answers before any confirm token is handed
    // out or taken, so its host is never touched.
    forgetSession: (id, confirmToken, refuse) =>
      canSee(id)
        ? ctx.forgetSession(id, confirmToken, refuse)
        : Promise.resolve('missing' as const),
    revokeSessionAuth: (id) => (canSee(id) ? ctx.revokeSessionAuth(id) : Promise.resolve(false)),
    updateSessionAuth: (id) => (canSee(id) ? ctx.updateSessionAuth(id) : Promise.resolve(null)),
    updateSession: (id, name, pinned) => canSee(id) && ctx.updateSession(id, name, pinned),
    updateSessionScope: (id, scope) =>
      canSee(id) ? ctx.updateSessionScope(id, scope) : Promise.resolve('missing' as const),
    ackSession: (id) => canSee(id) && ctx.ackSession(id),
    buildResumeCommand: (id) => (canSee(id) ? ctx.buildResumeCommand(id) : null),
    readSessionScreen: (id) =>
      canSee(id) ? ctx.readSessionScreen(id) : Promise.resolve('missing' as const),
    answerPermission: (request, decision) => {
      const owner = ctx.findPermissionSession(request);

      return owner !== null && canSee(owner) ? ctx.answerPermission(request, decision) : 'unknown';
    },
    attachSession: (client, sessionID, dims) =>
      canSee(sessionID) ? ctx.attachSession(client, sessionID, dims) : 'missing',
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
    readEvents: (afterID, limit, waitMs, sessionID, outer) => {
      const merged = outer === null ? access : outer.merge(access);

      return ctx.readEvents(afterID, limit, waitMs, sessionID, merged);
    },
    readReport: (id, outer) => ctx.readReport(id, mergeAccess(outer)),
    writeSessionMessage: (sessionID, from, text, keyed, outer) =>
      canSee(sessionID)
        ? ctx.writeSessionMessage(
            sessionID,
            from,
            text,
            buildPrincipalKey(keyed),
            mergeAccess(outer),
          )
        : Promise.resolve('missing' as const),
    readMessage: async (messageID, waitMs) => {
      // The owner is checked before any wait, so a message outside the
      // access answers at once, as an unknown message does.
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
    attachTap: (client, sessionID, outer) =>
      canSee(sessionID) ? ctx.attachTap(client, sessionID, mergeAccess(outer)) : 'missing',
    ackMessage: (client, sessionID, messageID, outer) =>
      canSee(sessionID)
        ? ctx.ackMessage(client, sessionID, messageID, mergeAccess(outer))
        : Promise.resolve('unknown' as const),
  };
}

// Throws the refusal of a spawn to a target the access leaves out.
function requireTarget(canUseTarget: (target: string) => boolean, target: string): void {
  if (!canUseTarget(target)) {
    throw buildTargetForbiddenError(target);
  }
}
