import { GATEWAY_PATHS } from '@atcx/contract';
import { normalizePublicURL } from './normalize-public-url';

// The resource `startMCPHTTPServer` will serve, known before it binds. Null
// when the origin is not yet known: an unusable public URL, which the server
// reports itself, or no public URL on port 0, where the OS picks the port.
export function findMCPResource(publicURL: string | null, port: number): string | null {
  if (publicURL !== null) {
    try {
      return `${normalizePublicURL(publicURL)}${GATEWAY_PATHS.machine.mcp}`;
    } catch {
      return null;
    }
  }

  return port === 0 ? null : `http://127.0.0.1:${port}${GATEWAY_PATHS.machine.mcp}`;
}
