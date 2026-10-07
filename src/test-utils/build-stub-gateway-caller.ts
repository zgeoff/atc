import { buildDaemonOutdatedError } from '../federation/build-daemon-outdated-error';
import type { FleetCaller } from '../mcp/types';
import type { DaemonFeature } from '../protocol/daemon-features';

interface StubGatewayOptions {
  // The name of the older daemon the gateway routes every request to.
  readonly daemon: string;

  // The feature that daemon's handshake lacks.
  readonly lacking: DaemonFeature;
}

/**
 * A fleet caller that stands in for a gateway routing to an older daemon
 * while another daemon behind it is current: it reports every feature the
 * caller it wraps reports, as a gateway reports the features of all its
 * daemons, refuses a request that requires the lacking feature with the
 * gateway's own `daemon_outdated` refusal, and passes every other request
 * to the wrapped caller unchanged.
 */
export function buildStubGatewayCaller(
  caller: FleetCaller,
  options: StubGatewayOptions,
): FleetCaller {
  return {
    sendRequest: (m, p, required, principal) =>
      required?.includes(options.lacking) === true
        ? Promise.reject(buildDaemonOutdatedError(options.daemon, options.lacking))
        : caller.sendRequest(m, p, required, principal),
    readFeatures: () => caller.readFeatures(),
  };
}
