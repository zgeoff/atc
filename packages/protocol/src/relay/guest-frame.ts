/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys, which the mux and the daemon both write */

// The frames the mux writes to the daemon.
export type GuestFrame =
  // echoes the hello's relay and gen
  | { t: 'welcome'; v: 1; relay: string; gen: number; ack: number; reset: boolean }

  // a reporter connected to the socket
  | { t: 'open'; seq: number; conn: number }
  | { t: 'line'; seq: number; conn: number; line: string }

  // the reporter closed its write side; it may still read
  | { t: 'end'; seq: number; conn: number }

  // the reporter's socket closed
  | { t: 'close'; seq: number; conn: number }
  | { t: 'ack'; ack: number };

// A welcome whose protocol version this build cannot speak, which a daemon answers by replacing
// the mux.
export interface ForeignWelcome {
  readonly t: 'welcome';
  readonly v: number;
  readonly relay: string;
  readonly gen: number;
}

export type ParsedGuestFrame = GuestFrame | ForeignWelcome;
