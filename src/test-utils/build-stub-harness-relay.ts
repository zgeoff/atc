import type { HarnessRelay } from '../daemon/execution-provider';

/**
 * A harness relay held in memory, as a provider hands one to the daemon for
 * a guest's connection. `sendLine` delivers a value as one JSON line from
 * the guest to every line listener, `written` holds every line written back
 * to the guest, parsed, in order, and `isClosed` turns true once the relay
 * is closed. A write settles at once, as a relay with room does. `emitClose`
 * runs every close listener, as a guest that hangs up does; closing the
 * relay from the daemon's end runs none.
 */
export function buildStubHarnessRelay() {
  const lineListeners: ((line: string) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  const written: unknown[] = [];
  let closed = false;

  const relay: HarnessRelay = {
    onLine: (listener) => {
      lineListeners.push(listener);
    },
    onClose: (listener) => {
      closeListeners.push(listener);
    },
    writeLine: (line) => {
      written.push(JSON.parse(line));

      return Promise.resolve();
    },
    close: () => {
      closed = true;
    },
  };

  return {
    relay,
    written,
    isClosed: () => closed,
    sendLine: (value: Readonly<Record<string, unknown>>) => {
      for (const listener of lineListeners) {
        listener(JSON.stringify(value));
      }
    },
    emitClose: () => {
      for (const listener of closeListeners) {
        listener();
      }
    },
  };
}
