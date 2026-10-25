export interface ObservedEvent {
  // Whether the subscription is gone, removed or past its refreshBefore.
  readonly isGone: boolean;
  readonly isStopped: boolean;

  // Whether the subscription's client holds a live grant with read.
  readonly reads: boolean;

  // Whether the event is of the subscription's type.
  readonly isMatch: boolean;
}

// stop leaves the position before the event; deliver and skip move it past.
export type EventStep = { readonly kind: 'stop' } | { readonly kind: 'deliver' | 'skip' };

// A client that lost read gets no delivery, and the position stays before the
// event, so the watcher's next turn decides whether its access is gone.
export function pickEventStep(observed: ObservedEvent): EventStep {
  if (observed.isGone || observed.isStopped || !observed.reads) {
    return { kind: 'stop' };
  }

  return { kind: observed.isMatch ? 'deliver' : 'skip' };
}
