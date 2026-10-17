import type { ATCInvocation } from '@atc/lifecycle';
import type { HostServices } from '@atc/plugin-api';

export function buildATCInvocation(host: HostServices): ATCInvocation {
  return { argv: host.atcArgv, readBuild: () => host.build };
}
