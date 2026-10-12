import type { DaemonFeature } from '../protocol/daemon-features';
import { GatewayError } from './gateway-error';

/**
 * The refusal for a call that relies on a feature the daemon's handshake
 * did not announce, holding the daemon's name and the missing feature.
 */
export function buildDaemonOutdatedError(daemon: string, feature: DaemonFeature): GatewayError {
  return new GatewayError(
    'daemon_outdated',
    `daemon '${daemon}' runs an atc build without ${feature}; call without the option that needs it, or upgrade that daemon`,
    { daemon, feature },
  );
}
