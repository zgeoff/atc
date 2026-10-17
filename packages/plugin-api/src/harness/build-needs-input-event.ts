import { truncateDetail } from '@atc/core';
import type { AdapterEvent } from '@atc/protocol';

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
