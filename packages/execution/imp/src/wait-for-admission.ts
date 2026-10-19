import type { LaunchTicket } from '@atc/plugin-api';
import type { ImpHarnessHost } from './imp-harness-host';
import type { ImpSessionRequest } from './imp-port';

// What an admission needs of the harness whose request waits for it.
interface AdmissionContext {
  readonly host: ImpHarnessHost;
  readonly isDone: () => boolean;
  readonly openConnection: (ticket?: LaunchTicket) => void;
  readonly applyAdmissionRefusal: (error: unknown) => void;
}

// A request with requirements opens only once the host admits it.
export async function waitForAdmission(
  kind: ImpSessionRequest['kind'],
  context: AdmissionContext,
): Promise<void> {
  const admit = context.host.admit;

  if (admit === undefined) {
    context.openConnection();

    return;
  }

  try {
    await admit(kind, (ticket) => {
      if (context.isDone() || context.host.isSuspending()) {
        ticket.release();
      } else {
        context.openConnection(ticket);
      }
    });
  } catch (error) {
    if (!context.isDone()) {
      context.applyAdmissionRefusal(error);
    }
  }
}
