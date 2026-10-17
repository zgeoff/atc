import { ImpPortError } from './imp-port-error';
import type { ImpdProcedure, ImpdRefusal } from './impd-contract';

/**
 * Builds the port error for a refusal impd's contract allows the procedure
 * to answer with, so a code the procedure never answers with, or data in
 * another shape, fails the type check.
 */
export function buildImpdRefusal<P extends ImpdProcedure>(
  _procedure: P,
  refusal: NoInfer<ImpdRefusal<P>>,
  message: string,
): ImpPortError {
  return new ImpPortError(refusal.code, message, refusal.data);
}
