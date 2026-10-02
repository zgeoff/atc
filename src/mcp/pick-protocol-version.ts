const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
]);

export function pickProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requested)) {
    return requested;
  }

  return '2025-11-25';
}
