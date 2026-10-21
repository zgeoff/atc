import type { HarnessAttachment, HarnessExit, HarnessStart } from '@atc/plugin-api';
import type { DaemonError } from '@atc/protocol/wire';

// The listeners on a harness's output, exit, and attachment, and the waits on
// its exit and its start, until the harness stops being followed.
export interface ImpHarnessEvents {
  readonly onData: (listener: (data: string) => void) => { readonly dispose: () => void };

  readonly onExit: (listener: (exit: HarnessExit) => void) => { readonly dispose: () => void };

  readonly onAttachment: (listener: (attachment: HarnessAttachment) => void) => {
    readonly dispose: () => void;
  };

  readonly waitForExit: (timeoutMs: number) => Promise<boolean>;

  readonly waitForStart: () => Promise<HarnessStart>;

  // The exit listeners as they stand, before an end drops them.
  readonly getExitListeners: () => ((exit: HarnessExit) => void)[];

  readonly emitData: (text: string) => void;

  readonly emitAttachment: (attachment: HarnessAttachment) => void;

  // Each wait on the start settles once the start has settled.
  readonly emitStartOutcome: (outcome: 'started' | Readonly<DaemonError>, created: boolean) => void;

  // Settles every wait on the exit and drops every listener.
  readonly dispose: (exited: boolean) => void;
}

export function createImpHarnessEvents(): ImpHarnessEvents {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(exit: HarnessExit) => void>();
  const attachmentListeners = new Set<(attachment: HarnessAttachment) => void>();

  // The waits on whether the process exited, until the harness stops being
  // followed.
  const exitWaiters = new Set<{
    readonly waited: PromiseWithResolvers<boolean>;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();

  // The waits on how the harness's start settles: started once a connection
  // first starts the process or attaches to it, or the refusal it ended
  // with before that.
  const startWaiters = new Set<PromiseWithResolvers<HarnessStart>>();

  return {
    onData: (listener) => {
      dataListeners.add(listener);

      return {
        dispose: () => {
          dataListeners.delete(listener);
        },
      };
    },

    onExit: (listener) => {
      exitListeners.add(listener);

      return {
        dispose: () => {
          exitListeners.delete(listener);
        },
      };
    },

    onAttachment: (listener) => {
      attachmentListeners.add(listener);

      return {
        dispose: () => {
          attachmentListeners.delete(listener);
        },
      };
    },

    waitForExit: (timeoutMs) => {
      const waited = Promise.withResolvers<boolean>();

      const waiter = {
        waited,
        timer: setTimeout(() => {
          exitWaiters.delete(waiter);
          waited.resolve(false);
        }, timeoutMs),
      };

      exitWaiters.add(waiter);

      return waited.promise;
    },

    waitForStart: () => {
      const waited = Promise.withResolvers<HarnessStart>();

      startWaiters.add(waited);

      return waited.promise;
    },

    getExitListeners: () => [...exitListeners],

    emitData: (text) => {
      for (const listener of dataListeners) {
        listener(text);
      }
    },

    emitAttachment: (attachment) => {
      for (const listener of attachmentListeners) {
        listener(attachment);
      }
    },

    emitStartOutcome: (outcome, created) => {
      for (const waited of startWaiters) {
        if (outcome === 'started') {
          waited.resolve({ created });
        } else {
          waited.reject(outcome);
        }
      }

      startWaiters.clear();
    },

    dispose: (exited) => {
      for (const waiter of exitWaiters) {
        clearTimeout(waiter.timer);

        waiter.waited.resolve(exited);
      }

      exitWaiters.clear();
      dataListeners.clear();
      exitListeners.clear();
      attachmentListeners.clear();
    },
  };
}
