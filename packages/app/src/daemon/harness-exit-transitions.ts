import type { HarnessExit } from '@atc/plugin-api';

// What one kind of harness exit does to its session.
interface HarnessExitTransition {
  // The session's last message, unless the exit carries a detail of its own
  // and the row takes it.
  readonly message: string;
  readonly takesDetail: boolean;

  // Whether the harness stays inside a host that went to sleep, so the
  // session lists as suspended and a revive wakes the host to find it.
  readonly suspends: boolean;

  // Whether the process itself ended, so its message bridge stops and its
  // undelivered messages are marked.
  readonly endsProcess: boolean;

  // Whether the fleet is written at once. A crash leaves the fleet as it
  // was, so a restore starts the harness again; a sleep is written, so a
  // restore after a daemon restart finds the harness asleep.
  readonly writesFleet: boolean;
}

/**
 * The transition a harness exit makes, one row per exit reason. An exit
 * with no reason is an `exited` exit.
 */
export const HARNESS_EXIT_TRANSITIONS: Readonly<
  Record<NonNullable<HarnessExit['reason']>, HarnessExitTransition>
> = {
  exited: {
    message: 'process exited',
    takesDetail: false,
    suspends: false,
    endsProcess: true,
    writesFleet: false,
  },
  suspended: {
    message: 'asleep',
    takesDetail: false,
    suspends: true,
    endsProcess: false,
    writesFleet: true,
  },
  ended: {
    message: 'host lost the process',
    takesDetail: true,
    suspends: false,
    endsProcess: false,
    writesFleet: false,
  },
};
