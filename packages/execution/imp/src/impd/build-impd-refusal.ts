import { ImpPortError } from '../port/imp-port-error';
import type { ImpdProcedure, ImpdRefusal } from './impd-procedure';

export function buildImpdRefusal<P extends ImpdProcedure>(
  _procedure: P,
  refusal: NoInfer<ImpdRefusal<P>>,
  message: string,
): ImpPortError {
  return new ImpPortError(refusal.code, message, refusal.data);
}
