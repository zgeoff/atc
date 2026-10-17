import type { ImpIdentity } from './imp-port';
import type { ImpdOutput } from './impd-contract';

/**
 * The caller's identity in the port's terms. An impd from before grantable
 * lists sends none, which grants nothing.
 */
export function toImpIdentity(
  identity: Pick<ImpdOutput<'tokens.whoami'>, 'kind' | 'name' | 'scope' | 'imps' | 'grantable'>,
): ImpIdentity {
  return {
    kind: identity.kind,
    name: identity.name,
    scope: identity.scope,
    imps: identity.imps === null ? null : [...identity.imps],
    grantable: [...(identity.grantable ?? [])],
  };
}
