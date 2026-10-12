import { isRecord } from './report';

/**
 * The settings `atc mcp --http` reads from config.json's `mcpHTTP` section.
 */
export interface MCPHTTPConfig {
  // The origin clients reach the server at, such as `https://mcp.example.com`.
  readonly publicURL: string | null;

  // The address the server binds.
  readonly host: string;
  readonly port: number;

  // Further Host header values to accept, for a proxy that rewrites Host.
  readonly allowedHosts: readonly string[];
}

/**
 * Reads the `mcpHTTP` section. An absent or wrong-typed field falls back to
 * its default: no public URL, host 127.0.0.1, port 8414, and no extra hosts.
 */
export function collectMCPHTTPConfig(raw: unknown): MCPHTTPConfig {
  if (!isRecord(raw)) {
    return { publicURL: null, host: '127.0.0.1', port: 8414, allowedHosts: [] };
  }

  const publicURL = raw['publicURL'];
  const host = raw['host'];
  const port = raw['port'];

  return {
    publicURL: typeof publicURL === 'string' && publicURL !== '' ? publicURL : null,
    host: typeof host === 'string' && host !== '' ? host : '127.0.0.1',
    port:
      typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535
        ? port
        : 8414,
    allowedHosts: collectStrings(raw['allowedHosts']),
  };
}

function collectStrings(raw: unknown): readonly string[] {
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string' && item !== '')
    : [];
}
