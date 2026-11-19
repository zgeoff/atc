import type { ProtocolMismatch } from './format-protocol-mismatch';

export function isClientBehind(
  mismatch: Pick<ProtocolMismatch, 'clientMajor' | 'daemonMajor'>,
): boolean {
  return mismatch.daemonMajor !== null && mismatch.daemonMajor > mismatch.clientMajor;
}
