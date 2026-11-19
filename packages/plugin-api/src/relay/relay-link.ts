import type { Clock } from '@atc/core';

export interface RelayLinkOpenOptions {
  readonly replace?: boolean;
}

export interface RelayLink {
  readonly open: (options?: RelayLinkOpenOptions) => Promise<RelayLinkConnection>;
}

export interface RelayLinkConnection {
  readonly onData: (listener: (data: Uint8Array) => void) => void;

  readonly onEnd: (listener: (end: 'dropped' | 'lost') => void) => void;

  readonly write: (data: Uint8Array) => Promise<void>;

  readonly detach: () => void;
}

export interface OpenedRelay {
  readonly listening: Promise<void>;

  readonly stop: () => void;
}

export interface StreamRelayOptions {
  readonly reconnectDelaysMs: readonly number[];
  readonly log?: (line: string) => void;

  readonly clock?: Clock;
}
