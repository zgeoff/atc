import type { LaunchTicket } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { ImpSessionRequest } from '../port/imp-port';
import type { ImpHarnessState } from './create-imp-harness-state';

interface GateContext {
  readonly name: string;
  readonly state: ImpHarnessState;

  readonly applyTicketRefusal: (refusal: unknown) => void;
}

// impd's client can fail a start after the connection opens without sending anything, for
// example when a feature check times out, so the start is marked sent only when the gate runs.
export function makeConnectionGate(
  request: ImpSessionRequest,
  ticket: LaunchTicket | undefined,
  context: GateContext,
): (() => boolean) | undefined {
  if (ticket !== undefined) {
    return () => checkTicket(ticket, request.kind, context);
  }

  if (request.kind === 'attach') {
    return undefined;
  }

  return () => {
    context.state.send({ type: 'START_SENT' });

    return true;
  };
}

// Refuse on a later microtask: the caller must hold the port first, because the refusal
// closes the connection before anything is sent and ends the harness.
function checkTicket(
  ticket: LaunchTicket,
  kind: ImpSessionRequest['kind'],
  context: GateContext,
): boolean {
  let refusal: DaemonError | null;

  try {
    refusal = ticket.check();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    refusal = new DaemonError(
      'internal',
      `imp ${context.name}'s harness could not check its admission: ${detail}`,
    );
  }

  if (refusal === null) {
    if (kind === 'start') {
      context.state.send({ type: 'START_SENT' });
    }

    return true;
  }

  queueMicrotask(() => {
    if (!context.state.isDone()) {
      context.applyTicketRefusal(refusal);
    }
  });

  return false;
}
