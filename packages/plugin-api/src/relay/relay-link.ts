import type { Clock } from '@atc/core';

export interface RelayLinkOpenOptions {
  // stops the mux the host still runs for this link first
  readonly replace?: boolean;
}

// What a provider supplies to carry the session bridge over a byte stream to a process in its
// host.
export interface RelayLink {
  // starts the guest's `atc relay-mux <socket>`, or attaches to the one the host still runs for this link.
  // replace: true stops that mux first and starts a new one.
  readonly open: (options?: RelayLinkOpenOptions) => Promise<RelayLinkConnection>;
}

export interface RelayLinkConnection {
  // the mux's stdout; may replay from any earlier byte, byte 0 included
  readonly onData: (listener: (data: Uint8Array) => void) => void;

  // lost: the host no longer runs the mux
  readonly onEnd: (listener: (end: 'dropped' | 'lost') => void) => void;

  // the mux's stdin
  readonly write: (data: Uint8Array) => Promise<void>;

  // lets go of the connection and leaves the mux running
  readonly detach: () => void;
}

export interface OpenedRelay {
  // resolves on the first welcome; rejects when the host lost the mux before it, or the relay
  // stopped first
  readonly listening: Promise<void>;

  // closes every bridge connection this relay carries, and detaches its connection
  readonly stop: () => void;
}

export interface StreamRelayOptions {
  // after the last delay, every retry waits the last delay, until stop()
  readonly reconnectDelaysMs: readonly number[];
  readonly log?: (line: string) => void;

  // times the welcome wait and the reconnect delays; the system clock when unset
  readonly clock?: Clock;
}
