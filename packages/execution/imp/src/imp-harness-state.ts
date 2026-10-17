import type { DaemonError } from '@atc/protocol/wire';
import { createActor } from 'xstate';
import type { EventFrom } from 'xstate';
import { IMP_HARNESS_MACHINE } from './imp-harness-machine';

// The harness's lifecycle: the actor that holds it and the questions the
// harness asks of it.
export class ImpHarnessState {
  // Whether the open connection started, whether the start went out, how
  // the next connection meets the screen, whether a kill waits, whether the
  // harness ended, and how its start settled.
  private readonly actor = createActor(IMP_HARNESS_MACHINE).start();

  send(event: EventFrom<typeof IMP_HARNESS_MACHINE>): void {
    this.actor.send(event);
  }

  isStarted(): boolean {
    return this.actor.getSnapshot().matches({ run: { following: { connection: 'live' } } });
  }

  isDone(): boolean {
    return this.actor.getSnapshot().matches({ run: 'ended' });
  }

  hasSentStart(): boolean {
    return this.actor.getSnapshot().matches({ run: { following: { process: 'sent' } } });
  }

  // Whether the next connection replaces the screen rather than resuming.
  needsFreshScreen(): boolean {
    return this.actor.getSnapshot().matches({ run: { following: { screen: 'fresh' } } });
  }

  hasPendingKill(): boolean {
    return this.actor.getSnapshot().matches({ run: { following: { kill: 'pending' } } });
  }

  // Whether the process exited, once the harness stops being followed;
  // null until then.
  getExitConfirmation(): boolean | null {
    const snapshot = this.actor.getSnapshot();

    if (snapshot.matches({ run: { ended: 'exited' } })) {
      return true;
    }

    return snapshot.matches({ run: 'ended' }) ? false : null;
  }

  // How the harness's start settled, or null while it has not.
  getStartOutcome(): 'started' | Readonly<DaemonError> | null {
    const snapshot = this.actor.getSnapshot();

    if (snapshot.matches({ start: 'started' })) {
      return 'started';
    }

    return snapshot.matches({ start: 'refused' }) ? snapshot.context.refusal : null;
  }
}
