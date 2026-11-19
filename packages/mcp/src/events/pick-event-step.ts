export interface ObservedEvent {
  readonly isGone: boolean;
  readonly isStopped: boolean;

  readonly reads: boolean;

  readonly isMatch: boolean;
}

export type EventStep = { readonly kind: 'stop' } | { readonly kind: 'deliver' | 'skip' };

// Lost read access stops instead of skipping: a stop leaves the position before the event,
// so the watcher's next turn decides whether its access is really gone.
export function pickEventStep(observed: ObservedEvent): EventStep {
  if (observed.isGone || observed.isStopped || !observed.reads) {
    return { kind: 'stop' };
  }

  return { kind: observed.isMatch ? 'deliver' : 'skip' };
}
