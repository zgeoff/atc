import type { MessageBridge, MessageBridgeRequest } from '@atc/plugin-api';

interface StubMessageBridge extends MessageBridge {
  // Each thread the daemon moved the bridge to, in order.
  readonly threads: string[];
  readonly countDeliveryStarts: () => number;
  readonly countStops: () => number;
}

interface StubMessageBridges {
  // Every start the daemon asked for, in order.
  readonly requests: MessageBridgeRequest[];

  // Every bridge started, in order.
  readonly bridges: StubMessageBridge[];
  readonly startMessageBridge: (request: MessageBridgeRequest) => Promise<StubMessageBridge>;
}

export function buildStubMessageBridges(): StubMessageBridges {
  const requests: MessageBridgeRequest[] = [];
  const bridges: StubMessageBridge[] = [];

  return {
    requests,
    bridges,
    startMessageBridge: (request) => {
      requests.push(request);

      const bridge = buildStubMessageBridge();

      bridges.push(bridge);

      return Promise.resolve(bridge);
    },
  };
}

function buildStubMessageBridge(): StubMessageBridge {
  const threads: string[] = [];
  let deliveryStarts = 0;
  let stops = 0;

  return {
    plan: { bin: 'stub-bridge', args: [] },
    threads,
    countDeliveryStarts: () => deliveryStarts,
    countStops: () => stops,
    startDelivery: () => {
      deliveryStarts += 1;
    },
    updateThread: (thread) => {
      threads.push(thread);
    },
    stop: () => {
      stops += 1;

      return Promise.resolve();
    },
  };
}
