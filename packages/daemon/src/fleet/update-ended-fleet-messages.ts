import { LOCAL_TARGET } from '@atc/config';
import type { StateStore } from '@atc/store';
import type { MessageService } from '../sessions/message-service';
import type { SessionManager } from '../sessions/sessions';

interface EndedFleetMessagesDeps {
  readonly manager: Pick<SessionManager, 'isLocalTarget' | 'isRevivable' | 'log'>;
  readonly store: Pick<StateStore, 'loadFleet'>;
  readonly messages: Pick<MessageService, 'updateEndedMessages' | 'updateRevivedMessages'>;

  // Whether the daemon restores the stored fleet as it starts.
  readonly isRestoring: boolean;
}

// every harness on the daemon's own machine ended with the previous daemon, so a session
// the restore revives takes its delivered messages again; one it cannot revive, or whose
// requeue fails, gets them marked unanswered, and their notices ask the sender to resend
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
          !deps.manager.isLocalTarget(x.target ?? LOCAL_TARGET.id),
      );

      if (!deps.manager.isLocalTarget(entry.target ?? LOCAL_TARGET.id)) {
        continue;
      }

      const owner = {
        atcID: entry.sessionID,
        ...(entry.agentSessionID === undefined || shared
          ? {}
          : { agentSessionID: entry.agentSessionID }),
      };

      if (!deps.isRestoring || !deps.manager.isRevivable(entry)) {
        await deps.messages.updateEndedMessages(entry.sessionID, owner);

        continue;
      }

      try {
        await deps.messages.updateRevivedMessages(entry.sessionID, owner);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        deps.manager.log(
          `atc could not requeue the messages of session ${entry.sessionID} for its revive (${reason}); it marks them unanswered`,
        );

        await deps.messages.updateEndedMessages(entry.sessionID, owner);
      }
    }
  } catch {}
}
