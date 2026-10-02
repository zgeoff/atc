import { DaemonError } from '../protocol/daemon-error';
import type { SessionID } from '../shared/session-id';
import type { DaemonContext } from './daemon-connection';
import type { KeyedRequest } from './idempotency-ledger';
import type { TargetAccess } from './target-access';

/**
 * The daemon as a principal with the given access sees it. Its keyed
 * spawns and messages hold their keys in the given namespace, apart from
 * every other namespace's. A session on a target outside the access does not exist here: every lookup of it answers
 * as a lookup of an unknown session does, so the request's own handling
 * refuses it with the words and data it gives a session that never
 * existed. Lists leave such sessions out, and a spawn may use only a target
 * the access holds.
 */
export function buildScopedContext(
  ctx: DaemonContext,
  access: TargetAccess,
  keyNamespace: string,
): DaemonContext {
  // A keyed request's key, held in this namespace alone.
  const buildPrincipalKey = (keyed: KeyedRequest | null): KeyedRequest | null =>
    keyed === null ? null : { ...keyed, principal: keyNamespace };

  const canSee = (id: SessionID): boolean => {
    const grant = ctx.findSessionGrant(id);

    return grant !== null && access.canUse(grant);
  };

  const canUseTarget = (target: string): boolean => {
    const targetIdentity = ctx.findTargetIdentity(target);

    return targetIdentity !== null && access.canUse({ target, targetIdentity });
  };

  return {
    ...ctx,
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
        targetErrors: list.targetErrors.filter(
          (error) => error.target === undefined || canUseTarget(error.target),
        ),
      };
    },
    collectFleet: async () => {
      const fleet = await ctx.collectFleet();

      return fleet.filter((entry) => canSee(entry.sessionID));
    },
    resolveSpawnTarget: (requested) => {
      if (requested !== undefined) {
        requireTarget(canUseTarget, requested);
      }

      const target = ctx.resolveSpawnTarget(requested);

      requireTarget(canUseTarget, target);

      return target;
    },
    spawnSession: (plan, keyed) => ctx.spawnSession(plan, buildPrincipalKey(keyed)),
    killSession: (id) => (canSee(id) ? ctx.killSession(id) : Promise.resolve(false)),
    updateSession: (id, name, pinned) => (canSee(id) ? ctx.updateSession(id, name, pinned) : false),
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
    ejectSession: (id, prompt) => (canSee(id) ? ctx.ejectSession(id, prompt) : 'missing'),
    adoptSession: (id, cols, rows) => (canSee(id) ? ctx.adoptSession(id, cols, rows) : 'missing'),
    resizeSession: (client, sessionID, dims) =>
      canSee(sessionID) && ctx.resizeSession(client, sessionID, dims),
    readSessionRecord: (id) =>
      canSee(id) ? ctx.readSessionRecord(id) : Promise.resolve('missing' as const),
    loadSessionTranscript: (id, from, limit) =>
      canSee(id) ? ctx.loadSessionTranscript(id, from, limit) : Promise.resolve('missing' as const),
    readEvents: (afterID, limit, waitMs, sessionID, outer) => {
      const merged = outer === null ? access : outer.merge(access);

      return ctx.readEvents(afterID, limit, waitMs, sessionID, merged);
    },
    writeSessionMessage: (sessionID, from, text, keyed) =>
      canSee(sessionID)
        ? ctx.writeSessionMessage(sessionID, from, text, buildPrincipalKey(keyed))
        : Promise.resolve('missing' as const),
    readMessage: async (messageID, waitMs) => {
      // The owner is checked before any wait, so a message outside the
      // access answers at once, as an unknown message does.
      const view = await ctx.readMessage(messageID, 0);

      if (view === null || !canSee(view.session)) {
        return null;
      }

      return waitMs === 0 ? view : ctx.readMessage(messageID, waitMs);
    },
    attachTap: (client, sessionID) =>
      canSee(sessionID) ? ctx.attachTap(client, sessionID) : 'missing',
    ackMessage: (client, sessionID, messageID) =>
      canSee(sessionID)
        ? ctx.ackMessage(client, sessionID, messageID)
        : Promise.resolve('unknown' as const),
  };
}

// Throws the refusal of a spawn to a target the access leaves out.
function requireTarget(canUseTarget: (target: string) => boolean, target: string): void {
  if (!canUseTarget(target)) {
    throw new DaemonError(
      'target_forbidden',
      `this client may not use execution target '${target}'. Grant it to the client under principals in config.json and restart the daemon`,
      { target },
    );
  }
}
