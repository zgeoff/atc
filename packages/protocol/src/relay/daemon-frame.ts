/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys, which the mux and the daemon both write */

export type DaemonFrame =
  | { t: 'hello'; v: 1; relay: string; gen: number; ack: number }
  | { t: 'line'; seq: number; conn: number; line: string }
  | { t: 'close'; seq: number; conn: number }
  | { t: 'ack'; ack: number };
