import type { LaunchTicket } from '@atc/plugin-api';

// What the harness asks of the provider that started it.
export interface ImpHarnessHost {
  // Whether the provider is putting the harness's host to sleep, so a
  // connection the sleep ends is the sleep's and not the harness's end.
  readonly isSuspending: () => boolean;

  // Called once, when the harness ends or the daemon lets go of it; for an
  // end, after every exit listener has run.
  readonly onDone: () => void;

  // The wait before each reconnect after a connection ends without an
  // exit; the harness ends once they run out.
  readonly reconnectDelaysMs: readonly number[];

  // Settles once the harness may start, such as when its report socket
  // listens; a rejection ends the harness before it starts.
  readonly ready?: Promise<void>;

  // Admits a request that has requirements by calling send, or rejects with the
  // refusal that ends the harness. The ticket is checked again just before the
  // request goes out, and a refusal there ends the harness with nothing sent.
  readonly admit?: (
    kind: 'start' | 'attach',
    send: (ticket: LaunchTicket) => void,
  ) => Promise<void>;
}
