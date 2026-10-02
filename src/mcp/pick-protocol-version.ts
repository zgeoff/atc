import { isSupportedProtocolVersion } from './is-supported-protocol-version';

export function pickProtocolVersion(requested: unknown): string {
  if (isSupportedProtocolVersion(requested)) {
    return requested;
  }

  return '2025-11-25';
}
