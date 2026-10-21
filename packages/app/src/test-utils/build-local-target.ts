import { LOCAL_TARGET } from '@atc/config';
import type { ExecutionTarget } from '@atc/daemon';
import { createLocalPTYProvider } from '@atc/execution-local';
import { buildTargetIdentity } from '@atc/store';

export function buildLocalTarget(): ExecutionTarget {
  return {
    id: LOCAL_TARGET.id,
    kind: LOCAL_TARGET.provider,
    options: LOCAL_TARGET.options,
    identity: buildTargetIdentity(LOCAL_TARGET.provider, LOCAL_TARGET.options),
    provider: createLocalPTYProvider(),
  };
}
