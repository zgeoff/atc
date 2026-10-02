import { isRecord } from './report';

/**
 * The settings `atc mcp --http` reads from config.json's `mcpHTTP` section.
 */
export interface MCPHTTPConfig {
  // The origin clients reach the server at, such as `https://mcp.example.com`.
  readonly publicURL: string | null;
  readonly port: number;

  // Further Host header values to accept, for a proxy that rewrites Host.
  readonly allowedHosts: readonly string[];

  // Hosts whose client id URLs atc may fetch as client metadata documents.
  readonly clientMetadataHosts: readonly string[];
}

/**
 * Reads the `mcpHTTP` section. An absent or wrong-typed field falls back to
 * its default: no public URL, port 8414, and no extra hosts of either kind.
 */
export function collectMCPHTTPConfig(raw: unknown): MCPHTTPConfig {
  if (!isRecord(raw)) {
    return { publicURL: null, port: 8414, allowedHosts: [], clientMetadataHosts: [] };
  }

  const publicURL = raw['publicURL'];
  const port = raw['port'];

  return {
    publicURL: typeof publicURL === 'string' && publicURL !== '' ? publicURL : null,
    port:
      typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65_535
        ? port
        : 8414,
    allowedHosts: collectStrings(raw['allowedHosts']),
    clientMetadataHosts: collectStrings(raw['clientMetadataHosts']),
  };
}

function collectStrings(raw: unknown): readonly string[] {
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string' && item !== '')
    : [];
}
