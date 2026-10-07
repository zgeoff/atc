import { isRecord } from '../shared/report';
import { truncateSummary } from '../shared/truncate-summary';

interface RenderableMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly result?: string;
  readonly message?: unknown;
}

/**
 * One structured SDK message → zero or one plain-text line for the session's
 * output pipe: assistant text verbatim, tool calls as compact one-liners,
 * results as a closing line.
 */
export function renderSDKMessage(message: RenderableMessage): string | null {
  if (message.type === 'assistant') {
    const inner = message.message;

    if (!isRecord(inner) || !Array.isArray(inner['content'])) {
      return null;
    }

    const content = inner['content'];
    const lines: string[] = [];

    for (const raw of content) {
      const block: unknown = raw;

      if (!isRecord(block)) {
        continue;
      }

      if (
        block['type'] === 'text' &&
        typeof block['text'] === 'string' &&
        block['text'].trim() !== ''
      ) {
        lines.push(block['text'].replaceAll('\n', '\r\n'));
      }

      if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        lines.push(`⚙ ${block['name']} ${truncateSummary(JSON.stringify(block['input'] ?? {}))}`);
      }
    }

    return lines.length === 0 ? null : lines.join('\r\n');
  }

  if (message.type === 'result') {
    return message.subtype === 'success'
      ? `— headless turn done: ${truncateSummary(message.result ?? '')}`
      : `— headless turn stopped: ${message.subtype ?? 'unknown'}`;
  }

  return null;
}
