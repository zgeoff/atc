import type { ExecutionTarget } from './build-execution-targets';

const UNVERSIONED_DIGEST = /^[\da-f]{16}$/u;

export function isUnconfirmedBinding(target: ExecutionTarget, identity: string): boolean {
  const prefix = `${target.kind}:`;

  return (
    target.identityRule !== undefined &&
    identity.startsWith(prefix) &&
    UNVERSIONED_DIGEST.test(identity.slice(prefix.length))
  );
}
