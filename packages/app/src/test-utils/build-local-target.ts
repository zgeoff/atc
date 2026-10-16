import { LOCAL_TARGET } from '@atc/config';
import { LocalPTYProvider } from '@atc/execution-local';
import { buildTargetIdentity } from '@atc/store';
import type { ExecutionTarget } from '../daemon/build-execution-targets';

/**
 * The `local` target a daemon serves when its config lists no targets: the
 * local pseudo-terminal provider, under the identity that config binds to.
 */
export function buildLocalTarget(): ExecutionTarget {
  return {
    id: LOCAL_TARGET.id,
    kind: LOCAL_TARGET.provider,
    options: LOCAL_TARGET.options,
    identity: buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
    provider: new LocalPTYProvider(),
  };
}
