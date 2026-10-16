import { LOCAL_TARGET } from '@atc/config';
import type { StateStore } from '@atc/store';
import type { MessageService } from '../sessions/message-service';
import type { SessionManager } from '../sessions/sessions';

interface EndedFleetMessagesDeps {
  readonly mgr: Pick<SessionManager, 'isLocalTarget'>;
  readonly store: Pick<StateStore, 'loadFleet'>;
  readonly messages: Pick<MessageService, 'updateEndedMessages'>;
}

/**
 * Marks the messages that the stored fleet's local sessions held delivered
 * as never answered. Every harness on the daemon's own machine ended with
 * the daemon before this one, so none of them answers. A row whose agent
 * session id a live row on a remote target holds marks only its own
 * messages: that session may still run there. A failure leaves the
 * messages as they were.
 */
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
