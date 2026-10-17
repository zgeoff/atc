import { truncateDetail } from '@atc/core';
import type { AdapterEvent } from '@atc/protocol';

// The longest stretch of a prompt that a prompt-submitted event previews.
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
