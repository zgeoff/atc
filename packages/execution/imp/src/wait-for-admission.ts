import type { LaunchTicket } from '@atc/plugin-api';
import type { ImpHarnessHost } from './imp-harness-host';
import type { ImpPort, ImpSessionOutcome, ImpSessionRequest } from './imp-port';

// What an admission needs of the harness whose request waits for it.
interface AdmissionContext {
  readonly port: ImpPort;
  readonly host: ImpHarnessHost;
  readonly name: string;
  readonly isDone: () => boolean;

  // Applies an outcome to a request that has not started.
  readonly applyOutcome: (outcome: ImpSessionOutcome) => void;

  readonly openConnection: (ticket?: LaunchTicket) => void;
  readonly applyAdmissionRefusal: (error: unknown) => void;
}

// A request with requirements opens only once impd shows it honours them and
// the host admits it.
export async function waitForAdmission(
  kind: ImpSessionRequest['kind'],
  context: AdmissionContext,
): Promise<void> {
  let execRequire: boolean;

  try {
    const features = await context.port.readFeatures();

    execRequire = features.execRequire;
  } catch (error) {
    if (!context.isDone() && !context.host.isSuspending()) {
      const detail = error instanceof Error ? error.message : String(error);

      context.applyOutcome({ kind: 'unreachable', detail });
    }

    return;
  }

  if (context.isDone() || context.host.isSuspending()) {
    return;
  }

  if (!execRequire) {
    context.applyOutcome({
      kind: 'failed',
      code: 'PRECONDITION_FAILED',
      message: `impd for imp ${context.name} does not honour exec requirements`,
      data: { reason: 'impd_outdated' },
    });

    return;
  }

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
