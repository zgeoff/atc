import type { HarnessAttachment, HarnessExit, HarnessStart } from '@atc/plugin-api';
import type { DaemonError } from '@atc/protocol/wire';

// The listeners on a harness's output, exit, and attachment, and the waits on
// its exit and its start, until the harness stops being followed.
export class ImpHarnessEvents {
  private readonly dataListeners = new Set<(data: string) => void>();

  private readonly exitListeners = new Set<(exit: HarnessExit) => void>();

  private readonly attachmentListeners = new Set<(attachment: HarnessAttachment) => void>();

  // The waits on whether the process exited, until the harness stops being
  // followed.
  private readonly exitWaiters = new Set<{
    readonly waited: PromiseWithResolvers<boolean>;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();

  // The waits on how the harness's start settles: started once a connection
  // first starts the process or attaches to it, or the refusal it ended
  // with before that.
  private readonly startWaiters = new Set<PromiseWithResolvers<HarnessStart>>();

  readonly onData = (listener: (data: string) => void) => {
    this.dataListeners.add(listener);

    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  };

  readonly onExit = (listener: (exit: HarnessExit) => void) => {
    this.exitListeners.add(listener);

    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  };

  readonly onAttachment = (listener: (attachment: HarnessAttachment) => void) => {
    this.attachmentListeners.add(listener);

    return {
      dispose: () => {
        this.attachmentListeners.delete(listener);
      },
    };
  };

  waitForExit(timeoutMs: number): Promise<boolean> {
    const waited = Promise.withResolvers<boolean>();

    const waiter = {
      waited,
      timer: setTimeout(() => {
        this.exitWaiters.delete(waiter);
        waited.resolve(false);
      }, timeoutMs),
    };

    this.exitWaiters.add(waiter);

    return waited.promise;
  }

  waitForStart(): Promise<HarnessStart> {
    const waited = Promise.withResolvers<HarnessStart>();

    this.startWaiters.add(waited);

    return waited.promise;
  }

  // The exit listeners as they stand, before an end drops them.
  getExitListeners(): ((exit: HarnessExit) => void)[] {
    return [...this.exitListeners];
  }

  emitData(text: string): void {
    for (const listener of this.dataListeners) {
      listener(text);
    }
  }

  emitAttachment(attachment: HarnessAttachment): void {
    for (const listener of this.attachmentListeners) {
      listener(attachment);
    }
  }

  // Each wait on the start settles once the start has settled.
  emitStartOutcome(outcome: 'started' | Readonly<DaemonError>, created: boolean): void {
    for (const waited of this.startWaiters) {
      if (outcome === 'started') {
        waited.resolve({ created });
      } else {
        waited.reject(outcome);
      }
    }

    this.startWaiters.clear();
  }

  // Settles every wait on the exit and drops every listener.
  dispose(exited: boolean): void {
    for (const waiter of this.exitWaiters) {
      clearTimeout(waiter.timer);

      waiter.waited.resolve(exited);
    }

    this.exitWaiters.clear();
    this.dataListeners.clear();
    this.exitListeners.clear();
    this.attachmentListeners.clear();
  }
}
