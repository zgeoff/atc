import { truncateDetail } from '@atc/core/truncate-detail';
import type { AdapterEvent } from '@atc/protocol/adapter-event';

/**
 * The agent waits on a person: the event on top of `base`, holding what it
 * asks as its message and bounded as its detail when the line held a
 * non-empty one.
 */
export function buildNeedsInputEvent(
  base: Readonly<AdapterEvent>,
  message: string | undefined,
): AdapterEvent {
  return {
    ...base,
    kind: 'needs-input',
    ...(message === undefined || message === ''
      ? {}
      : { message, detail: truncateDetail(message) }),
  };
}
