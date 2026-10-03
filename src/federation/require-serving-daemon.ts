import type { DaemonFeature } from '../protocol/daemon-features';
import type { DaemonCaller, DaemonHello } from './daemon-caller';
import { GatewayError } from './gateway-error';
import type { RegistryDaemon } from './types';

/**
 * The handshake of the daemon a call is about to reach, read from the
 * connection the call rides. Throws `daemon_outdated` with the daemon's
 * name when that daemon lacks a feature the call needs, so a daemon that
 * would ignore an option never answers as if it had honoured it, and
 * whatever the daemon caller throws when the daemon cannot be reached.
 */
export async function requireServingDaemon(
  getCaller: (name: string) => DaemonCaller,
  daemon: RegistryDaemon,
  required: readonly DaemonFeature[],
): Promise<DaemonHello> {
  const hello = await getCaller(daemon.name).readHello();

  const missing = required.find((feature) => !hello.features.has(feature));

  if (missing !== undefined) {
    throw new GatewayError(
      'daemon_outdated',
      `daemon '${daemon.name}' runs an atc build without ${missing}; call without the option that needs it, or upgrade that daemon`,
      { daemon: daemon.name, feature: missing },
    );
  }

  return hello;
}
