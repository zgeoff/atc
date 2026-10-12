import { truncateDetail } from '@atc/core/truncate-detail';
import type { AdapterEvent } from '@atc/protocol/adapter-event';

// The longest stretch of a prompt that a prompt-submitted event previews.
const PROMPT_PREVIEW_LENGTH = 80;

/**
 * A person submitted a prompt: the event on top of `base`, previewing the
 * prompt's start when the line held a non-empty prompt.
 */
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
