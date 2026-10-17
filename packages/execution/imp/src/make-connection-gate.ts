import type { LaunchTicket } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { ImpHarnessState } from './imp-harness-state';
import type { ImpSessionRequest } from './imp-port';

// What a connection's gate needs of the harness whose request it guards.
interface GateContext {
  readonly name: string;
  readonly state: ImpHarnessState;

  // Ends the harness with the refusal of a ticket whose check failed.
  readonly applyTicketRefusal: (refusal: unknown) => void;
}

// impd's client can fail a start after the connection opens, as a feature
// check that times out does, sending nothing; so only the gate marks it sent.
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

// A refusal or a throw closes the connection unsent and ends the harness once
// the port has returned to the caller. Only a start that passes counts as sent.
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
