import type { DaemonProcedures as ClientProcedures } from '@atcx/client';
import type { CallContext } from '@atcx/client/connection';
import type { DaemonEvent } from '@atcx/contract';
import type { DaemonChannel } from '../wire/daemon-channel';

export type DaemonProcedures = ClientProcedures<CallContext>;

export interface DaemonClient extends DaemonChannel {
  onEvent: (event: DaemonEvent) => void;
  onClose: () => void;

  onAnswer: (method: string, ok: Readonly<Record<string, unknown>>) => void;

  principal: string | undefined;

  readonly procedures: DaemonProcedures;

  readonly isClosed: () => boolean;
}
