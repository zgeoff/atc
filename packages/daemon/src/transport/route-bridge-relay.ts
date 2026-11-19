import type { HarnessRelay } from '@atc/plugin-api';
import { isPeerMessage } from './is-peer-message';

interface BridgeRoutes {
  readonly openBridge: (relay: HarnessRelay) => void;
  readonly openClient: (relay: HarnessRelay) => void;
}

export function routeBridgeRelay(relay: HarnessRelay, routes: BridgeRoutes): void {
  const lineListeners: ((line: string) => void)[] = [];
  const endListeners: (() => void)[] = [];
  let routed = false;

  const routedRelay: HarnessRelay = {
    onLine: (listener) => {
      lineListeners.push(listener);
    },
    onClose: (listener) => {
      relay.onClose(listener);
    },
    onEnd: (listener) => {
      endListeners.push(listener);
    },
    writeLine: (line) => relay.writeLine(line),
    close: () => {
      relay.close();
    },
  };

  relay.onLine((line) => {
    if (!routed) {
      routed = true;

      if (isPeerMessage(line)) {
        routes.openClient(routedRelay);
      } else {
        routes.openBridge(routedRelay);
      }
    }

    for (const listener of lineListeners) {
      listener(line);
    }
  });

  relay.onEnd(() => {
    if (!routed) {
      relay.close();

      return;
    }

    for (const listener of endListeners) {
      listener();
    }
  });
}
