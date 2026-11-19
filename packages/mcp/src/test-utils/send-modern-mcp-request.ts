import { readJSONRecord } from '@atc/core/test-utils/read-json-record';

interface ModernMCPAnswer {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export async function sendModernMCPRequest(
  url: string,
  token: string,
  method: string,
  params: Readonly<Record<string, unknown>> = {},
): Promise<ModernMCPAnswer> {
  const name = params['name'];

  const answered = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {
            extensions: { 'io.modelcontextprotocol/events': {} },
          },
          'io.modelcontextprotocol/clientInfo': { name: 'atc-test-client', version: '0.0.1' },
        },
      },
    }),
  });

  return { status: answered.status, body: await readJSONRecord(answered) };
}
