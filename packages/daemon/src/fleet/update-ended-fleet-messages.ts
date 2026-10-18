import { LOCAL_TARGET } from '@atc/config';
import type { StateStore } from '@atc/store';
import type { MessageService } from '../sessions/message-service';
import type { SessionManager } from '../sessions/sessions';

interface EndedFleetMessagesDeps {
  readonly mgr: Pick<SessionManager, 'isLocalTarget'>;
  readonly store: Pick<StateStore, 'loadFleet'>;
  readonly messages: Pick<MessageService, 'updateEndedMessages' | 'updateRevivedMessages'>;

  // Whether the daemon restores the stored fleet as it starts.
  readonly isRestoring: boolean;
}

// every harness on the daemon's own machine ended with the previous daemon, so no turn
// answers what it held delivered: a session the restore revives takes those messages
// again, and one it leaves exited or unrestored gets them marked unanswered
export async function updateEndedFleetMessages(deps: EndedFleetMessagesDeps): Promise<void> {
  try {
    const fleet = await deps.store.loadFleet();

    for (const entry of fleet) {
      const shared = fleet.some(
        (x) =>
          x.sessionID !== entry.sessionID &&
          x.agentSessionID !== undefined &&
          x.agentSessionID === entry.agentSessionID &&
          x.exited !== true &&
          !deps.mgr.isLocalTarget(x.target ?? LOCAL_TARGET.id),
      );

      if (!deps.mgr.isLocalTarget(entry.target ?? LOCAL_TARGET.id)) {
        continue;
      }

      const owner = {
        atcID: entry.sessionID,
        ...(entry.agentSessionID === undefined || shared
          ? {}
          : { agentSessionID: entry.agentSessionID }),
      };

      await (deps.isRestoring && entry.exited !== true
        ? deps.messages.updateRevivedMessages(entry.sessionID, owner)
        : deps.messages.updateEndedMessages(entry.sessionID, owner));
    }
  } catch {}
}
