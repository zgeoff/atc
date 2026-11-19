import { GATEWAY_PATHS } from '@atcx/contract';
import { normalizePublicURL } from './normalize-public-url';

// A bad public URL yields no origin because the server reports that error itself; port 0
// with no public URL has none either, because the OS picks the port only at bind time.
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
