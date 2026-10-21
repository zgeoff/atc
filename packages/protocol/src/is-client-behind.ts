import type { ProtocolMismatch } from './format-protocol-mismatch';

// A daemon whose refusal holds no version predates the field, so it is older
// than any client that reads the field.
export function isClientBehind(
  mismatch: Pick<ProtocolMismatch, 'clientProtocol' | 'daemonProtocol'>,
): boolean {
  return mismatch.daemonProtocol !== null && mismatch.daemonProtocol > mismatch.clientProtocol;
}
