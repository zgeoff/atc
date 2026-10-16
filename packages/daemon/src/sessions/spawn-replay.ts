import { isRecord } from '@atc/core';
import type { DaemonAnswer } from '@atc/protocol';
import { SPAWN_ANSWER_SCHEMA } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import type { IdempotencyRecord, StateStore } from '@atc/store';
import { buildGrantFromFleetEntry } from '../auth/build-grant-from-fleet-entry';
import { buildTargetForbiddenError } from '../auth/build-target-forbidden-error';
import { isTreeInReach } from '../auth/is-tree-in-reach';
import type { TargetAccess } from '../auth/target-access';
import type { SessionManager } from './sessions';

interface SpawnReplayDeps {
  readonly mgr: Pick<SessionManager, 'sessions' | 'collectDescriptors'>;
  readonly store: Pick<StateStore, 'loadFleet'>;
}

/**
 * Answers a retried spawn under an idempotency key the ledger completed:
 * with the session as it stands now when it is listed, else with the
 * descriptor the first spawn answered. Under an access, a replay whose
 * session the access does not reach is refused as a fresh spawn to its
 * target would be.
 */
export class SpawnReplay {
  private readonly mgr: SpawnReplayDeps['mgr'];

  private readonly store: SpawnReplayDeps['store'];

  constructor(deps: SpawnReplayDeps) {
    this.mgr = deps.mgr;
    this.store = deps.store;
  }

  // The tree may change while the fleet is read, so the live check runs
  // again in the step that answers.
  async loadReplay(
    record: IdempotencyRecord,
    access: TargetAccess | null,
  ): Promise<DaemonAnswer<'session.spawn'>> {
    if (access === null) {
      return this.loadAnswer(record);
    }

    this.requireLiveTreeInReach(record, access);

    await this.requireStoredTreeInReach(record, access);

    this.requireLiveTreeInReach(record, access);

    return this.loadAnswer(record);
  }

  // A key that start-up reconciliation completed has no stored answer, and
  // its session lists only once the fleet is restored.
  private loadAnswer(record: IdempotencyRecord): DaemonAnswer<'session.spawn'> {
    const listed = this.mgr.collectDescriptors().find((d) => d.id === record.effectRef);

    if (listed !== undefined) {
      return { session: listed };
    }

    const result: unknown = record.result === null ? null : JSON.parse(record.result);
    const stored = SPAWN_ANSWER_SCHEMA.safeParse(result);

    if (stored.success) {
      return stored.data;
    }

    throw new DaemonError(
      'no_such_session',
      `the spawn under idempotency key '${record.key}' created session '${record.effectRef}', which is not listed; restore the fleet to list it`,
      { effectRef: record.effectRef },
    );
  }

  // Throws the refusal a fresh spawn to the target gets when the access
  // does not reach the target, and the identity, a held spawn key recorded
  // for its session. A key that records none is refused: nothing it holds
  // shows where its session ran. A session the daemon still holds is
  // refused the same way when the access does not reach its whole tree.
  private requireLiveTreeInReach(record: IdempotencyRecord, access: TargetAccess): void {
    const bound = record.effectTarget;

    if (bound === null) {
      throw buildTargetForbiddenError(findReplayTarget(record));
    }

    const sessions = this.mgr.sessions;
    const session = sessions.find((x) => x.id === record.effectRef);

    if (
      !access.canUse(bound) ||
      (session !== undefined && !isTreeInReach(sessions, session.id, access))
    ) {
      throw buildTargetForbiddenError(bound.target);
    }
  }

  // Throws the refusal of a replay out of reach when a held spawn key's
  // session is no longer live and the access does not reach the whole tree
  // its fleet rows hold, as the live check refuses a live tree. A session
  // with no fleet row has no tree left to check.
  private async requireStoredTreeInReach(
    record: IdempotencyRecord,
    access: TargetAccess,
  ): Promise<void> {
    if (this.mgr.sessions.some((x) => x.id === record.effectRef)) {
      return;
    }

    const fleet = await this.store.loadFleet();

    const members = fleet.map((entry) => {
      const grant = buildGrantFromFleetEntry(entry);

      return {
        id: entry.sessionID,
        parent: entry.parent ?? null,
        target: grant.target,
        targetIdentity: grant.targetIdentity,
      };
    });

    const own = members.find((member) => member.id === record.effectRef);

    if (own !== undefined && !isTreeInReach(members, own.id, access)) {
      throw buildTargetForbiddenError(record.effectTarget?.target ?? findReplayTarget(record));
    }
  }
}

// The target a held spawn key's stored answer holds its session on, for a
// refusal of its replay; the answer holds no other target to name.
function findReplayTarget(record: IdempotencyRecord): string {
  const stored: unknown = record.result === null ? null : JSON.parse(record.result);
  const session = isRecord(stored) ? stored['session'] : null;
  const locator = isRecord(session) ? session['locator'] : null;

  return isRecord(locator) && typeof locator['targetID'] === 'string'
    ? locator['targetID']
    : 'unknown';
}
