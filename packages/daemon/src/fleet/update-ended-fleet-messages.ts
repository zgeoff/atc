import { LOCAL_TARGET } from '@atc/config';
import type { StateStore } from '@atc/store';
import type { MessageService } from '../sessions/create-message-service';
import type { SessionManager } from '../sessions/create-session-manager';

interface EndedFleetMessagesDeps {
  readonly manager: Pick<SessionManager, 'isLocalTarget'>;
  readonly store: Pick<StateStore, 'loadFleet'>;
  readonly messages: Pick<MessageService, 'updateEndedMessages'>;
}

// every harness on the daemon's own machine ended with the previous daemon, so each delivered
// message of a local session is marked unanswered, a revived one's too: its agent may already
// hold the message, and a second delivery would repeat the work
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

      await deps.messages.updateEndedMessages(entry.sessionID, owner);
    }
  } catch {}
}
