import type { ContractRouterClient } from '@orpc/contract';
import type { DAEMON_CONTRACT } from '../daemon-contract';
import type { DaemonEvent } from '../daemon-event';
import type { DaemonChannel } from '../wire/daemon-channel';

// The principal one call acts as, and the name that labels a message it
// sends.
export interface CallContext {
  readonly as?: string | undefined;
  readonly asName?: string | undefined;
}

export type DaemonProcedures = ContractRouterClient<typeof DAEMON_CONTRACT, CallContext>;

// A connection to the daemon that speaks oRPC peer messages, one JSON
// message per line, and delivers the connection's events through its
// subscription once the handshake passes.
export interface DaemonClient extends DaemonChannel {
  onEvent: (event: DaemonEvent) => void;
  onClose: () => void;

  // Sees each answer before its request resolves with it. A throw rejects
  // the request with the thrown message as an `internal` error.
  onAnswer: (method: string, ok: Readonly<Record<string, unknown>>) => void;

  // The principal a request acts as when it gives none. A daemon serves a
  // request over TCP only as a principal, so a client that reaches one over
  // TCP sets it once its handshake has passed instead of on every request.
  principal: string | undefined;

  // Every procedure, typed by the contract; a refusal rejects with a
  // DaemonError.
  readonly procedures: DaemonProcedures;

  // Whether the connection ended. A request sent afterwards rejects at once
  // with the reason it ended, such as a failed event subscription.
  readonly isClosed: () => boolean;
}
