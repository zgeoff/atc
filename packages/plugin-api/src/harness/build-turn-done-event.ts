import { truncateDetail } from '@atc/core';
import type { AdapterEvent } from '@atc/protocol';

/**
 * The agent finished its turn: the event on top of `base`, holding the
 * turn's last message whole as its result and bounded as its detail when
 * the line held a non-empty one.
 */
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
