import type { DAEMON_CONTRACT, DaemonEvent } from '@atcx/contract';
import type { ContractRouterClient } from '@orpc/contract';
import type { DaemonChannel } from '../wire/daemon-channel';

export interface CallContext {
  readonly as?: string | undefined;
  readonly asName?: string | undefined;
}

export type DaemonProcedures = ContractRouterClient<typeof DAEMON_CONTRACT, CallContext>;

export interface DaemonClient extends DaemonChannel {
  onEvent: (event: DaemonEvent) => void;
  onClose: () => void;

  onAnswer: (method: string, ok: Readonly<Record<string, unknown>>) => void;

  principal: string | undefined;

  readonly procedures: DaemonProcedures;

  readonly isClosed: () => boolean;
}
