import type { MessageBridge, MessageBridgeRequest } from '@atc/plugin-api';

interface StubMessageBridge extends MessageBridge {
  readonly threads: string[];
  readonly countDeliveryStarts: () => number;
  readonly countStops: () => number;

  readonly holdStops: () => void;
  readonly finishStops: () => void;

  readonly updateStopsFail: (fail: boolean) => void;
}

interface StubMessageBridges {
  readonly requests: MessageBridgeRequest[];

  readonly bridges: StubMessageBridge[];
  readonly startMessageBridge: (request: MessageBridgeRequest) => Promise<StubMessageBridge>;

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
