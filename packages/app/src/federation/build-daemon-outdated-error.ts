import type { DaemonFeature } from '@atc/protocol';
import { GatewayError } from './gateway-error';

export function buildDaemonOutdatedError(daemon: string, feature: DaemonFeature): GatewayError {
  return new GatewayError(
    'daemon_outdated',
    `daemon '${daemon}' runs an atc build without ${feature}; call without the option that needs it, or upgrade that daemon`,
    { daemon, feature },
  );
}
