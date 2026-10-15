import { truncate, truncateToBytes } from '@atc/core';
import type { TranscriptRow } from '@atc/protocol';
import { match } from 'ts-pattern';
import { z } from 'zod';

// One row must stay far under the protocol's line cap.
const MAX_ROW_TEXT_BYTES = 16_384;

// A user or assistant line of the transcript. Its content is the prompt's
// text or a list of blocks, each read on its own so a block of another
// kind leaves the rest of the line readable.
const ContentSchema = z.string().or(z.array(z.unknown()));

const TranscriptLineSchema = z.object({
  type: z.enum(['user', 'assistant']),
  isSidechain: z.unknown().optional(),
  isMeta: z.unknown().optional(),
  timestamp: z.unknown().optional(),
  message: z.object({ content: ContentSchema }),
});

const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), name: z.string(), input: z.unknown().optional() }),
]);

export function parseClaudeTranscriptLine(line: string): TranscriptRow | null {
  let raw: unknown;

  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }

  const parsed = TranscriptLineSchema.safeParse(raw);

  if (!parsed.success || parsed.data.isSidechain === true || parsed.data.isMeta === true) {
    return null;
  }

  const content = parsed.data.message.content;
  const blocks = typeof content === 'string' ? [] : collectContentBlocks(content);

  const text =
    typeof content === 'string'
      ? content
      : blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');

  const tools = blocks.flatMap((block) =>
    match(block)
      .with({ type: 'tool_use' }, (b) => [{ name: b.name, input: formatToolInput(b.input) }])
      .with({ type: 'text' }, () => [])
      .exhaustive(),
  );

  if (text === '' && tools.length === 0) {
    return null;
  }

  const timestamp = parsed.data.timestamp;
  const parsedAt = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;

  return {
    role: parsed.data.type,
    text: truncateToBytes(text, MAX_ROW_TEXT_BYTES),
    tools,
    at: Number.isNaN(parsedAt) ? null : parsedAt,
  };
}

function collectContentBlocks(content: readonly unknown[]): z.infer<typeof ContentBlockSchema>[] {
  return content.flatMap((block) => {
    const parsed = ContentBlockSchema.safeParse(block);

    return parsed.success ? [parsed.data] : [];
  });
}

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

const ToolInputSchema = z.record(z.string(), z.unknown());

function formatToolInput(input: unknown): string {
  const parsed = ToolInputSchema.safeParse(input);

  if (!parsed.success) {
    return '';
  }

  const fields = parsed.data;
  const key = TOOL_INPUT_KEYS.find((k) => typeof fields[k] === 'string');
  const summary = key === undefined ? JSON.stringify(fields) : String(fields[key]);

  return truncate(summary, 200);
}
