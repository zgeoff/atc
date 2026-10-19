import type { Principal } from '@atc/protocol';
import type { FleetCaller, FleetFeature } from '../mcp/types';

interface StubFleetRequest {
  readonly m: string;
  readonly p?: Readonly<Record<string, unknown>>;
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
}

export function buildStubFleetCaller(
  config: StubFleetCallerConfig = {},
): FleetCaller & { readonly requests: readonly StubFleetRequest[] } {
  const answer: StubFleetAnswer = config.answer ?? (() => ({}));
  const features: readonly FleetFeature[] = config.features ?? [];
  const requests: StubFleetRequest[] = [];

  return {
    requests,
    sendRequest: (m, p, principal) => {
      const request: StubFleetRequest = {
        m,
        ...(p === undefined ? {} : { p }),
        ...(principal === undefined ? {} : { principal }),
      };

      requests.push(request);

      return Promise.try(() => answer(request));
    },
    readFeatures: () => Promise.resolve(new Set(features)),
  };
}
