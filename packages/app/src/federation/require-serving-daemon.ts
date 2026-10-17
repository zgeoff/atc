import type { DaemonFeature } from '@atc/protocol';
import { buildDaemonOutdatedError } from './build-daemon-outdated-error';
import type { GatewayDaemonCaller } from './gateway-daemon-caller';
import type { DaemonHello, RegistryDaemon } from './types';

export async function requireServingDaemon(
  getCaller: (name: string) => GatewayDaemonCaller,
  daemon: RegistryDaemon,
  required: readonly DaemonFeature[],
): Promise<DaemonHello> {
  const hello = await getCaller(daemon.name).readHello();

  const missing = required.find((feature) => !hello.features.has(feature));

  // a daemon that would ignore an option the call relies on must never answer as if it
  // had honoured it
  if (missing !== undefined) {
    throw buildDaemonOutdatedError(daemon.name, missing);
  }

  return hello;
}
