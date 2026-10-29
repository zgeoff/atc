import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import { match } from 'ts-pattern';
import type { DaemonContext, HeldAtcAccess } from '../daemon-context';
import { buildScopedContext } from './build-scoped-context';
import { buildSessionSetAccess } from './build-session-set-access';
import { buildTargetForbiddenError } from './build-target-forbidden-error';

// Each check reads the live subtree, so a session the holder spawns is in
// reach at once.
export function buildGrantedContext(
  ctx: DaemonContext,
  holder: SessionID,
  held: HeldAtcAccess,
  method: string,
): DaemonContext {
  const isInSubtree = (id: SessionID): boolean => ctx.collectSubtree(holder).has(id);
  const isInReach = (id: SessionID): boolean => id === holder || isInSubtree(id);
  const messageParent = held.parent ?? held.spawner;

  const canReach = match(method)
    .with('session.message', () => (id: SessionID) => isInReach(id) || id === messageParent)
    .with('session.kill', 'session.forget', () => isInSubtree)

    // A spawn under a session in reach lands under that session's own parent
    // when it is a sub-session, which is the holder's parent for a
    // sub-session holder, so the spawn's parent check admits that one too.
    .with('session.spawn', () => (id: SessionID) => isInReach(id) || id === held.parent)
    .otherwise(() => isInReach);

  const scoped = buildScopedContext(
    ctx,
    buildSessionSetAccess(held.grant, canReach),
    `session:${holder}`,
  );

  return {
    ...scoped,
    requireGrantableAccess: (scopes) => {
      const missing = scopes.filter((scope) => !held.scopes.includes(scope));

      if (missing.length > 0) {
        throw new DaemonError(
          'unauthorized',
          `session '${holder}' holds atc access ${held.scopes.join(', ')}, so its spawn cannot grant ${missing.join(', ')}`,
        );
      }
    },
    resolveSpawnTarget: (requested) => {
      if (requested !== undefined && requested !== held.grant.target) {
        throw buildTargetForbiddenError(requested);
      }

      return scoped.resolveSpawnTarget(held.grant.target);
    },
  };
}
