import { ImpPortError } from './imp-port-error';
import type { ImpdProcedure, ImpdRefusal } from './impd-contract';

// The procedure argument only types the refusal against impd's contract.
export function buildImpdRefusal<P extends ImpdProcedure>(
  _procedure: P,
  refusal: NoInfer<ImpdRefusal<P>>,
  message: string,
): ImpPortError {
  return new ImpPortError(refusal.code, message, refusal.data);
}
