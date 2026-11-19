import type { ProtocolMismatch } from './format-protocol-mismatch';

export function isClientBehind(
  mismatch: Pick<ProtocolMismatch, 'clientProtocol' | 'daemonProtocol'>,
): boolean {
  return mismatch.daemonProtocol !== null && mismatch.daemonProtocol > mismatch.clientProtocol;
}
