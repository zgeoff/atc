import type { HarnessRelay } from '@atc/plugin-api';

export function buildStubHarnessRelay() {
  const lineListeners: ((line: string) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  const endListeners: (() => void)[] = [];
  const written: unknown[] = [];
  let closed = false;

  const relay: HarnessRelay = {
    onLine: (listener) => {
      lineListeners.push(listener);
    },
    onClose: (listener) => {
      closeListeners.push(listener);
    },
    onEnd: (listener) => {
      endListeners.push(listener);
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
    emitEnd: () => {
      for (const listener of endListeners) {
        listener();
      }
    },
  };
}
