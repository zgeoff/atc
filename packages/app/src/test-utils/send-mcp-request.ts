import { getRecord } from '../shared/get-record';
import { readJSONRecord } from './read-json-record';

/**
 * Posts one JSON-RPC request to an MCP HTTP server's `/mcp` endpoint with
 * the given access token as a bearer token, and returns the response's
 * `result`. Throws when the body is not a JSON object with an object
 * `result`, such as a JSON-RPC error.
 */
export async function sendMCPRequest(
  url: string,
  token: string,
  method: string,
  params: Readonly<Record<string, unknown>> = {},
): Promise<Readonly<Record<string, unknown>>> {
  const answered = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  const body = await readJSONRecord(answered);

  return getRecord(body, 'result');
}
