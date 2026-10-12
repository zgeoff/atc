import type { DaemonFeature } from '../protocol/daemon-features';
import { buildDaemonOutdatedError } from './build-daemon-outdated-error';
import type { DaemonCaller, DaemonHello } from './daemon-caller';
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
    throw buildDaemonOutdatedError(daemon.name, missing);
  }

  return hello;
}
