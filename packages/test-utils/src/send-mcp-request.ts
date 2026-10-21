import { getRecord } from './get-record';
import { readJSONRecord } from './read-json-record';

export async function sendMCPRequest(
  url: string,
  token: string,
  method: string,
  params: Readonly<Record<string, unknown>> = {},
): Promise<Readonly<Record<string, unknown>>> {
  const answered = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  const body = await readJSONRecord(answered);

  return getRecord(body, 'result');
}
