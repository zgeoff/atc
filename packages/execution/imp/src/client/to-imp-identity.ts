import type { ImpdOutput } from '../impd/impd-procedure';
import type { ImpIdentity } from '../port/imp-port';

export function toImpIdentity(
  identity: Pick<ImpdOutput<'tokens.whoami'>, 'kind' | 'name' | 'scope' | 'imps' | 'grantable'>,
): ImpIdentity {
  return {
    kind: identity.kind,
    name: identity.name,
    scope: identity.scope,
    imps: identity.imps === null ? null : [...identity.imps],

    // An impd from before grantable lists sends none, which grants nothing.
    grantable: [...(identity.grantable ?? [])],
  };
}
