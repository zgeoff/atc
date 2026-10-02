import { isRecord } from '../shared/report';
import { truncateToBytes } from '../shared/truncate-to-bytes';
import type { TranscriptRow, TranscriptToolUse } from './agent-adapter';

// One row must stay far under the protocol's line cap.
const MAX_ROW_TEXT_BYTES = 16_384;

const TOOL_INPUT_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
];

export function parseClaudeTranscriptLine(line: string): TranscriptRow | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const type = parsed['type'];

  if (type !== 'user' && type !== 'assistant') {
    return null;
  }

  if (parsed['isSidechain'] === true || parsed['isMeta'] === true) {
    return null;
  }

  const message = parsed['message'];

  if (!isRecord(message)) {
    return null;
  }

  const content = message['content'];
  const texts: string[] = [];
  const tools: TranscriptToolUse[] = [];

  if (typeof content === 'string') {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content as unknown[]) {
      if (!isRecord(block)) {
        continue;
      }

      const text = block['text'];
      const name = block['name'];

      if (block['type'] === 'text' && typeof text === 'string') {
        texts.push(text);
      } else if (block['type'] === 'tool_use' && typeof name === 'string') {
        tools.push({ name, input: formatToolInput(block['input']) });
      }
    }
  } else {
    return null;
  }

  const text = texts.join('\n');

  if (text === '' && tools.length === 0) {
    return null;
  }

  const timestamp = parsed['timestamp'];
  const parsedAt = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;

  return {
    role: type,
    text: truncateToBytes(text, MAX_ROW_TEXT_BYTES),
    tools,
    at: Number.isNaN(parsedAt) ? null : parsedAt,
  };
}

function formatToolInput(input: unknown): string {
  if (!isRecord(input)) {
    return '';
  }

  let summary = JSON.stringify(input);

  for (const key of TOOL_INPUT_KEYS) {
    const value = input[key];

    if (typeof value === 'string') {
      summary = value;
      break;
    }
  }

  return summary.length <= 200 ? summary : `${summary.slice(0, 199)}…`;
}
