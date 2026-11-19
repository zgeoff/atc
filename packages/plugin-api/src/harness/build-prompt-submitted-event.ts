import { truncateDetail } from '@atc/core';
import type { AdapterEvent } from '@atc/protocol';

const PROMPT_PREVIEW_LENGTH = 80;

export function buildPromptSubmittedEvent(
  base: Readonly<AdapterEvent>,
  prompt: string | undefined,
): AdapterEvent {
  const preview = prompt === undefined ? '' : prompt.slice(0, PROMPT_PREVIEW_LENGTH);

  return {
    ...base,
    kind: 'prompt-submitted',
    ...(preview === '' ? {} : { message: preview, detail: truncateDetail(preview) }),
  };
}
