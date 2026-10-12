import type { ATCInvocation } from '@atc/lifecycle/atc-invocation';
import { buildCLIArgv } from './agents/build-cli-argv';
import { getATCBuild } from './shared/get-atc-build';

/**
 * How this process runs atc again: the argv that starts its CLI, and the
 * build stamp read from its source tree or baked into its binary. The entry
 * builds it once and hands it to everything that starts or greets a daemon.
 */
export function buildATCInvocation(): ATCInvocation {
  return { argv: buildCLIArgv(), readBuild: getATCBuild };
}
