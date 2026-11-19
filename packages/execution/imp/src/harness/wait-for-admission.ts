import type { LaunchTicket } from '@atc/plugin-api';
import type { ImpSessionRequest } from '../port/imp-port';
import type { ImpHarnessHost } from './imp-harness-host';

interface AdmissionContext {
  readonly host: ImpHarnessHost;
  readonly isDone: () => boolean;
  readonly openConnection: (ticket?: LaunchTicket) => void;
  readonly applyAdmissionRefusal: (error: unknown) => void;
}

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
