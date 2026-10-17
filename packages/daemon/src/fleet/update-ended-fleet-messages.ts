import { LOCAL_TARGET } from '@atc/config';
import type { StateStore } from '@atc/store';
import type { MessageService } from '../sessions/message-service';
import type { SessionManager } from '../sessions/sessions';

interface EndedFleetMessagesDeps {
  readonly mgr: Pick<SessionManager, 'isLocalTarget'>;
  readonly store: Pick<StateStore, 'loadFleet'>;
  readonly messages: Pick<MessageService, 'updateEndedMessages'>;
}

// every harness on the daemon's own machine ended with the previous daemon, so none
// of those messages will be answered
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

      if (deps.mgr.isLocalTarget(entry.target ?? LOCAL_TARGET.id)) {
        await deps.messages.updateEndedMessages(entry.sessionID, {
          atcID: entry.sessionID,
          ...(entry.agentSessionID === undefined || shared
            ? {}
            : { agentSessionID: entry.agentSessionID }),
        });
      }
    }
  } catch {}
}
