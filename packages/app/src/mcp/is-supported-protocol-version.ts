const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
  '2025-11-25',
  '2025-06-18',
  '2024-11-05',
]);

/**
 * Whether atc's MCP server speaks a protocol version. It leaves out
 * `2025-03-26`, which requires JSON-RPC batching that atc does not implement.
 */
export function isSupportedProtocolVersion(version: unknown): version is string {
  return typeof version === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(version);
}
