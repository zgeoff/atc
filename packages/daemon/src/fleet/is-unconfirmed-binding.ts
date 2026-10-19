import type { ExecutionTarget } from './build-execution-targets';

const UNVERSIONED_DIGEST = /^[\da-f]{16}$/u;

// A binding that holds the kind and a bare digest, on a target whose plugin
// versions its identities. A restore confirms it against the existing host
// instead of refusing it as a changed target.
export function isUnconfirmedBinding(target: ExecutionTarget, identity: string): boolean {
  const prefix = `${target.kind}:`;

  return (
    target.identityRule !== undefined &&
    identity.startsWith(prefix) &&
    UNVERSIONED_DIGEST.test(identity.slice(prefix.length))
  );
}
