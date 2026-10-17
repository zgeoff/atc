import { truncateDetail } from '@atc/core';
import type { AdapterEvent } from '@atc/protocol';

export function buildTurnDoneEvent(
  base: Readonly<AdapterEvent>,
  lastMessage: string | undefined,
): AdapterEvent {
  return {
    ...base,
    kind: 'turn-done',
    ...(lastMessage === undefined || lastMessage === ''
      ? {}
      : { detail: truncateDetail(lastMessage), result: lastMessage }),
  };
}
