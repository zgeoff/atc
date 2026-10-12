/**
 * Folds a typed approval code to the form it was minted in: upper case, with
 * spaces and dashes dropped, and the letters Crockford base32 reads as digits
 * (I and L as 1, O as 0) replaced.
 */
export function normalizeApprovalCode(typed: string): string {
  return typed.toUpperCase().replaceAll(/[\s-]/g, '').replaceAll(/[IL]/g, '1').replaceAll('O', '0');
}
