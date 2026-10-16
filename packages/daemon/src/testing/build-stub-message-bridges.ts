import type { MessageBridge, MessageBridgeRequest } from '@atc/plugin-api';

/**
 * A message bridge stand-in and the start an adapter offers it through:
 * each start records its request and answers with a fresh bridge that
 * plans the `stub-bridge` binary and records what the daemon asks of it.
 */
interface StubMessageBridges {
  // Every start the daemon asked for, in order.
  readonly requests: MessageBridgeRequest[];

  // Every bridge started, in order.
  readonly bridges: StubMessageBridge[];
  readonly startMessageBridge: (request: MessageBridgeRequest) => Promise<StubMessageBridge>;
}

interface StubMessageBridge extends MessageBridge {
  // Each thread the daemon moved the bridge to, in order.
  readonly threads: string[];
  readonly countDeliveryStarts: () => number;
  readonly countStops: () => number;
}

/**
 * A bridge source for daemon tests: an adapter that spreads in its
 * `startMessageBridge` takes its messages through a bridge in the daemon,
 * and the test reads each request's host to drive the daemon's side.
 */
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
