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
  // Gives the reply to one request: a value, a promise, or a throw, which
  // the caller turns into a rejection, as a daemon refusal arrives.
  readonly answer?: StubFleetAnswer;

  // The features the caller reports; none, as a single daemon reports, by default.
  readonly features?: readonly FleetFeature[];

  // Whether a wait for the daemon resolves, as when one answers; true by default.
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
