import { PROCEDURE_TRAITS, REQUEST_PARAM_SCHEMAS } from '@atc/protocol';

/**
 * Whether a request method is open to the daemon's owner alone, as its
 * contract traits hold. A method the protocol does not define is not: it
 * runs as no request and is answered as unknown.
 */
export function isOwnerOnlyMethod(method: string): boolean {
  return (
    Object.hasOwn(REQUEST_PARAM_SCHEMAS, method) && PROCEDURE_TRAITS.get(method)?.access === 'owner'
  );
}
