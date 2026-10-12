import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultError,
  SDKResultSuccess,
} from '@anthropic-ai/claude-agent-sdk';
import { truncateSummary } from '@atc/core/truncate-summary';
import { match } from 'ts-pattern';

type ContentBlock = SDKAssistantMessage['message']['content'][number];

// The fields of an SDK content block that the output line reads.
type RenderableBlock =
  | Pick<Extract<ContentBlock, { type: 'text' }>, 'type' | 'text'>
  | Pick<Extract<ContentBlock, { type: 'tool_use' }>, 'type' | 'name' | 'input'>
  | Pick<Exclude<ContentBlock, { type: 'text' | 'tool_use' }>, 'type'>;

/**
 * The fields of an SDK message that its output line reads. Every SDK
 * message carries them.
 */
export type RenderableSDKMessage =
  | {
      readonly type: SDKAssistantMessage['type'];
      readonly message: { readonly content: readonly RenderableBlock[] };
    }
  | Pick<SDKResultSuccess, 'type' | 'subtype' | 'result'>
  | Pick<SDKResultError, 'type' | 'subtype'>
  | Pick<Exclude<SDKMessage, { type: 'assistant' | 'result' }>, 'type'>;

/**
 * One structured SDK message → zero or one plain-text line for the session's
 * output pipe: assistant text verbatim, tool calls as compact one-liners,
 * results as a closing line.
 */
export function renderSDKMessage(message: RenderableSDKMessage): string | null {
  return match(message)
    .with({ type: 'assistant' }, (m) => renderAssistantContent(m.message.content))
    .with(
      { type: 'result', subtype: 'success' },
      (m) => `— headless turn done: ${truncateSummary(m.result)}`,
    )
    .with({ type: 'result' }, (m) => `— headless turn stopped: ${m.subtype}`)
    .otherwise(() => null);
}

function renderAssistantContent(content: readonly RenderableBlock[]): string | null {
  const lines = content.flatMap((block) =>
    match(block)
      .with({ type: 'text' }, (b) =>
        b.text.trim() === '' ? [] : [b.text.replaceAll('\n', '\r\n')],
      )
      .with({ type: 'tool_use' }, (b) => [
        `⚙ ${b.name} ${truncateSummary(JSON.stringify(b.input ?? {}))}`,
      ])
      .otherwise(() => []),
  );

  return lines.length === 0 ? null : lines.join('\r\n');
}
