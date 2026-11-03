import type { MessageBridge, MessageBridgeRequest } from '@atc/plugin-api';

interface StubMessageBridge extends MessageBridge {
  // Each thread the daemon moved the bridge to, in order.
  readonly threads: string[];
  readonly countDeliveryStarts: () => number;
  readonly countStops: () => number;

  // Keeps each later stop pending until the test finishes the stops, as an App Server that takes
  // time to exit.
  readonly holdStops: () => void;
  readonly finishStops: () => void;

  // Makes each later stop reject, as an App Server that refuses to exit, until the test sets it
  // back.
  readonly updateStopsFail: (fail: boolean) => void;
}

interface StubMessageBridges {
  // Every start the daemon asked for, in order.
  readonly requests: MessageBridgeRequest[];

  // Every bridge started, in order.
  readonly bridges: StubMessageBridge[];
  readonly startMessageBridge: (request: MessageBridgeRequest) => Promise<StubMessageBridge>;

  // Keeps each later start pending until the test finishes the starts, so two launches overlap.
  // The bridge joins `bridges` when its start is asked for.
  readonly holdStarts: () => void;
  readonly finishStarts: () => void;
}

export function buildStubMessageBridges(): StubMessageBridges {
  const requests: MessageBridgeRequest[] = [];
  const bridges: StubMessageBridge[] = [];
  let heldStarts: PromiseWithResolvers<void> | null = null;

  return {
    requests,
    bridges,
    startMessageBridge: async (request) => {
      requests.push(request);

      const bridge = buildStubMessageBridge();

      bridges.push(bridge);

      await heldStarts?.promise;

      return bridge;
    },
    holdStarts: () => {
      heldStarts = Promise.withResolvers<void>();
    },
    finishStarts: () => {
      heldStarts?.resolve();
      heldStarts = null;
    },
  };
}

function buildStubMessageBridge(): StubMessageBridge {
  const threads: string[] = [];
  let deliveryStarts = 0;
  let stops = 0;
  let heldStops: PromiseWithResolvers<void> | null = null;
  let stopsFail = false;

  return {
    plan: { bin: 'stub-bridge', args: [] },
    threads,
    countDeliveryStarts: () => deliveryStarts,
    countStops: () => stops,
    holdStops: () => {
      heldStops = Promise.withResolvers<void>();
    },
    finishStops: () => {
      heldStops?.resolve();
      heldStops = null;
    },
    updateStopsFail: (fail) => {
      stopsFail = fail;
    },
    startDelivery: () => {
      deliveryStarts += 1;
    },
    updateThread: (thread) => {
      threads.push(thread);
    },
    stop: () => {
      stops += 1;

      if (stopsFail) {
        return Promise.reject(new Error('the app server did not exit'));
      }

      return heldStops?.promise ?? Promise.resolve();
    },
  };
}
