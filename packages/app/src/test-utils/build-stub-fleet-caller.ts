import type { FleetCaller, FleetFeature } from '../mcp/types';
import type { DaemonFeature } from '../protocol/daemon-features';
import { DAEMON_FEATURES } from '../protocol/daemon-features';

/**
 * One request a stub fleet caller received: the method and each further
 * argument the sender passed, with an argument left undefined left out.
 */
interface StubFleetRequest {
  readonly m: string;
  readonly p?: Readonly<Record<string, unknown>>;
  readonly required?: readonly DaemonFeature[];
  readonly principal?: string;
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

/**
 * A fleet caller that stands in for a daemon connection: it records every
 * request in `requests`, in the order sent, and replies through the
 * config's `answer`, by default an empty record. It reports the config's
 * `features`, by default every feature a current daemon announces, and it
 * checks no request's required features against them, so a test that needs
 * that refusal uses a real connection.
 */
export function buildStubFleetCaller(
  config: StubFleetCallerConfig = {},
): FleetCaller & { readonly requests: readonly StubFleetRequest[] } {
  const answer: StubFleetAnswer = config.answer ?? (() => ({}));
  const features: readonly FleetFeature[] = config.features ?? DAEMON_FEATURES;
  const requests: StubFleetRequest[] = [];

  return {
    requests,
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
