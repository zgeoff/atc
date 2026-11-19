import type { HarnessExit } from '@atc/plugin-api';

interface HarnessExitTransition {
  readonly message: string;
  readonly takesDetail: boolean;

  readonly suspends: boolean;

  readonly endsProcess: boolean;

  // A crash leaves the fleet as it was, so a restore starts the harness again. A sleep is written,
  // so a restore after a daemon restart finds the harness asleep.
  readonly writesFleet: boolean;
}

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
