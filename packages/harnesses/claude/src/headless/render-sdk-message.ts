import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultError,
  SDKResultSuccess,
} from '@anthropic-ai/claude-agent-sdk';
import { truncateSummary } from '@atc/core';
import { match } from 'ts-pattern';

type ContentBlock = SDKAssistantMessage['message']['content'][number];

// The fields of an SDK content block that the output line reads.
type RenderableBlock =
  | Pick<Extract<ContentBlock, { type: 'text' }>, 'type' | 'text'>
  | Pick<Extract<ContentBlock, { type: 'tool_use' }>, 'type' | 'name' | 'input'>
  | Pick<Exclude<ContentBlock, { type: 'text' | 'tool_use' }>, 'type'>;

export type RenderableSDKMessage =
  | {
      readonly type: SDKAssistantMessage['type'];
      readonly message: { readonly content: readonly RenderableBlock[] };
    }
  | Pick<SDKResultSuccess, 'type' | 'subtype' | 'result'>
  | Pick<SDKResultError, 'type' | 'subtype'>
  | Pick<Exclude<SDKMessage, { type: 'assistant' | 'result' }>, 'type'>;

export function renderSDKMessage(message: RenderableSDKMessage): string | null {
  return match(message)
    .with({ type: 'assistant' }, (assistant) => renderAssistantContent(assistant.message.content))
    .with(
      { type: 'result', subtype: 'success' },
      (success) => `— headless turn done: ${truncateSummary(success.result)}`,
    )
    .with({ type: 'result' }, (stopped) => `— headless turn stopped: ${stopped.subtype}`)
    .otherwise(() => null);
}

function renderAssistantContent(content: readonly RenderableBlock[]): string | null {
  const lines = content.flatMap((block) =>
    match(block)
      .with({ type: 'text' }, (textBlock) =>
        textBlock.text.trim() === '' ? [] : [textBlock.text.replaceAll('\n', '\r\n')],
      )
      .with({ type: 'tool_use' }, (toolUse) => [
        `⚙ ${toolUse.name} ${truncateSummary(JSON.stringify(toolUse.input ?? {}))}`,
      ])
      .otherwise(() => []),
  );

  return lines.length === 0 ? null : lines.join('\r\n');
}
