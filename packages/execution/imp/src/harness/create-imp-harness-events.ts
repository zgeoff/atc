import type { HarnessAttachment, HarnessExit, HarnessStart } from '@atc/plugin-api';
import type { AtcError } from '@atcx/contract/light';

export interface ImpHarnessEvents {
  readonly onData: (listener: (data: string) => void) => { readonly dispose: () => void };

  readonly onExit: (listener: (exit: HarnessExit) => void) => { readonly dispose: () => void };

  readonly onAttachment: (listener: (attachment: HarnessAttachment) => void) => {
    readonly dispose: () => void;
  };

  readonly waitForExit: (timeoutMs: number) => Promise<boolean>;

  readonly waitForStart: () => Promise<HarnessStart>;

  readonly getExitListeners: () => ((exit: HarnessExit) => void)[];

  readonly emitData: (text: string) => void;

  readonly emitAttachment: (attachment: HarnessAttachment) => void;

  readonly emitStartOutcome: (outcome: 'started' | Readonly<AtcError>, created: boolean) => void;

  readonly dispose: (exited: boolean) => void;
}

export function createImpHarnessEvents(): ImpHarnessEvents {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(exit: HarnessExit) => void>();
  const attachmentListeners = new Set<(attachment: HarnessAttachment) => void>();

  const exitWaiters = new Set<{
    readonly waited: PromiseWithResolvers<boolean>;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();

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
