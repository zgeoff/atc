import type { ATCInvocation } from '@atc/lifecycle/atc-invocation';
import type { HostServices } from '@atc/plugin-api/host-services';

/**
 * How this process runs atc again, from its host services: the argv that
 * starts its CLI, and its build stamp, read again on every call. The entry
 * builds it once and hands it to everything that starts or greets a daemon.
 */
export function buildATCInvocation(host: HostServices): ATCInvocation {
  return { argv: host.atcArgv, readBuild: () => host.build };
}
