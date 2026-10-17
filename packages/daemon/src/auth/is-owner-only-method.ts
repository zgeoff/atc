import { PROCEDURE_TRAITS, REQUEST_PARAM_SCHEMAS } from '@atc/protocol';

export function isOwnerOnlyMethod(method: string): boolean {
  return (
    Object.hasOwn(REQUEST_PARAM_SCHEMAS, method) && PROCEDURE_TRAITS.get(method)?.access === 'owner'
  );
}
