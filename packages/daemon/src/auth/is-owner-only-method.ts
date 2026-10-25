import { PROCEDURE_TRAITS } from '@atc/protocol';
import { REQUEST_PARAM_SCHEMAS } from '@atcx/contract';

export function isOwnerOnlyMethod(method: string): boolean {
  return (
    Object.hasOwn(REQUEST_PARAM_SCHEMAS, method) && PROCEDURE_TRAITS.get(method)?.access === 'owner'
  );
}
