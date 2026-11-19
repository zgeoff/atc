import type { LaunchTicket } from '@atc/plugin-api';

export interface ImpHarnessHost {
  // True while the provider puts the host to sleep. A connection that drops then was cut by
  // the sleep, so the harness does not end.
  readonly isSuspending: () => boolean;

  readonly onDone: () => void;

  // The wait before each reconnect after a connection ends without an
  // exit; the harness ends once they run out.
  readonly reconnectDelaysMs: readonly number[];

  // Settles once the harness may start, such as when its report socket
  // listens; a rejection ends the harness before it starts.
  readonly ready?: Promise<void>;

  readonly admit?: (
    kind: 'start' | 'attach',
    send: (ticket: LaunchTicket) => void,
  ) => Promise<void>;
}
