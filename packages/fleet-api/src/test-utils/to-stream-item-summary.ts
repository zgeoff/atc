import { isRecord } from '@atc/core';
import { getEventMeta } from '@orpc/server';

// The kind of an events.stream item, its oRPC event id, and for a daemons item its unavailable and
// started lists.
export function toStreamItemSummary(item: unknown): unknown[] {
  const kind = isRecord(item) ? item['kind'] : undefined;

  const lists =
    isRecord(item) && kind === 'daemons' ? [item['unavailable'], item['started']] : null;

  return [kind, getEventMeta(item)?.id, lists];
}
