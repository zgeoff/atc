import type { Principal } from '@atc/protocol';
import type { FleetCaller, FleetFeature } from '../tools/types';

interface StubFleetRequest {
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly principal?: Principal;
}

type StubFleetAnswer = (
  request: StubFleetRequest,
) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;

interface StubFleetCallerConfig {
  // A throw here reaches the caller as a rejection, the same way a real daemon's refusal arrives.
  readonly answer?: StubFleetAnswer;

  // Defaults to none because a single daemon reports no features.
  readonly features?: readonly FleetFeature[];

  readonly reachable?: boolean;
}

export function buildStubFleetCaller(
  config: StubFleetCallerConfig = {},
): FleetCaller & { readonly requests: readonly StubFleetRequest[] } {
  const answer: StubFleetAnswer = config.answer ?? (() => ({}));
  const features: readonly FleetFeature[] = config.features ?? [];
  const requests: StubFleetRequest[] = [];

  return {
    requests,
    sendRequest: (method, params, principal) => {
      const request: StubFleetRequest = {
        method,
        ...(params === undefined ? {} : { params }),
        ...(principal === undefined ? {} : { principal }),
      };

      requests.push(request);

      return Promise.try(() => answer(request));
    },
    features: new Set(features),
    waitForDaemon: () =>
      config.reachable === false
        ? Promise.reject(new Error('no daemon listens'))
        : Promise.resolve(),
  };
}
