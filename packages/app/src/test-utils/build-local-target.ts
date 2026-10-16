import { LOCAL_TARGET } from '@atc/config';
import type { ExecutionTarget } from '@atc/daemon';
import { LocalPTYProvider } from '@atc/execution-local';
import { buildTargetIdentity } from '@atc/store';

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
