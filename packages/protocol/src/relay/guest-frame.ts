/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys, which the mux and the daemon both write */

export type GuestFrame =
  | { t: 'welcome'; v: 1; relay: string; gen: number; ack: number; reset: boolean }
  | { t: 'open'; seq: number; conn: number }
  | { t: 'line'; seq: number; conn: number; line: string }
  | { t: 'end'; seq: number; conn: number }
  | { t: 'close'; seq: number; conn: number }
  | { t: 'ack'; ack: number };

export interface ForeignWelcome {
  readonly t: 'welcome';
  readonly v: number;
  readonly relay: string;
  readonly gen: number;
}

export type ParsedGuestFrame = GuestFrame | ForeignWelcome;
