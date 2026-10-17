import type { DaemonFeature, Principal } from '@atc/protocol';
import { DAEMON_FEATURES } from '@atc/protocol';
import type { FleetCaller, FleetFeature } from '../mcp/types';

interface StubFleetRequest {
  readonly m: string;
  readonly p?: Readonly<Record<string, unknown>>;
  readonly required?: readonly DaemonFeature[];
  readonly principal?: Principal;
}

type StubFleetAnswer = (
  request: StubFleetRequest,
) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;

interface StubFleetCallerConfig {
  // Gives the reply to one request: a value, a promise, or a throw, which
  // the caller turns into a rejection, as a daemon refusal arrives.
  readonly answer?: StubFleetAnswer;

  // The features the caller reports its daemon announced.
  readonly features?: readonly FleetFeature[];
}

export function buildStubFleetCaller(
  config: StubFleetCallerConfig = {},
): FleetCaller & { readonly requests: readonly StubFleetRequest[] } {
  const answer: StubFleetAnswer = config.answer ?? (() => ({}));
  const features: readonly FleetFeature[] = config.features ?? DAEMON_FEATURES;
  const requests: StubFleetRequest[] = [];

  return {
    requests,

    // required features are never checked against the reported ones, so a test
    // of that refusal needs a real connection.
    sendRequest: (m, p, required, principal) => {
      const request: StubFleetRequest = {
        m,
        ...(p === undefined ? {} : { p }),
        ...(required === undefined ? {} : { required }),
        ...(principal === undefined ? {} : { principal }),
      };

      requests.push(request);

      return Promise.try(() => answer(request));
    },
    readFeatures: () => Promise.resolve(new Set(features)),
  };
}
