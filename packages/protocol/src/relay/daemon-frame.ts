/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys, which the mux and the daemon both write */

// The frames the daemon writes to a guest's `atc relay-mux`, one JSON object per line. Each side
// numbers the frames it sends in `seq`, and applies only the frame one past the last it applied.
export type DaemonFrame =
  // relay: new per `openStreamRelay` call; gen: new per connection
  | { t: 'hello'; v: 1; relay: string; gen: number; ack: number }

  // a line the daemon writes to a reporter
  | { t: 'line'; seq: number; conn: number; line: string }

  // the daemon closed its side of the bridge connection
  | { t: 'close'; seq: number; conn: number }

  // the highest guest seq the daemon applied
  | { t: 'ack'; ack: number };
