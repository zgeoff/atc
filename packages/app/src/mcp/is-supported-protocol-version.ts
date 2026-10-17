// 2025-03-26 is left out: it requires JSON-RPC batching, which atc does not implement.
const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  '2025-11-25',
  '2025-06-18',
  '2024-11-05',
]);

export function isSupportedProtocolVersion(version: unknown): version is string {
  return typeof version === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(version);
}
