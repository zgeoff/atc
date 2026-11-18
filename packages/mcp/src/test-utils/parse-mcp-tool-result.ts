import { isRecord } from '@atc/core';

export interface MCPToolResult {
  readonly isError: unknown;
  readonly text: string;
  readonly structured: Readonly<Record<string, unknown>> | undefined;
}

export function parseMCPToolResult(response: Readonly<Record<string, unknown>>): MCPToolResult {
  const result = response['result'];
  const content = isRecord(result) ? result['content'] : undefined;
  const item: unknown = Array.isArray(content) && content.length === 1 ? content[0] : undefined;
  const structured = isRecord(result) ? result['structuredContent'] : undefined;

  if (
    !isRecord(result) ||
    !isRecord(item) ||
    typeof item['text'] !== 'string' ||
    (structured !== undefined && !isRecord(structured))
  ) {
    throw new TypeError(`tool call returned an unexpected result: ${JSON.stringify(response)}`);
  }

  return { isError: result['isError'], text: item['text'], structured };
}
