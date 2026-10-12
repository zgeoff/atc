import { encodeCursor } from '../protocol/encode-cursor';
import { encodeGatewayCursor } from './encode-gateway-cursor';
import { MAX_EVENTS_CURSOR_BYTES } from './max-events-cursor-bytes';

/**
 * The most daemons a registry may list: the largest count whose worst-case
 * events cursor still fits the bytes the gateway reads back. The worst case
 * gives every daemon a name of the longest allowed length and a position at
 * the largest event id a daemon cursor can hold, under the longest filter
 * hash, so any cursor a registry this size produces decodes again.
 */
export const MAX_REGISTRY_DAEMONS = (() => {
  const position = encodeCursor({ kind: 'events', id: Number.MAX_SAFE_INTEGER });

  const parts = new Map<string, string>();

  for (;;) {
    const index = String(parts.size);

    parts.set(`${'a'.repeat(31 - index.length)}${index}.ffffffff`, position);

    if (Buffer.byteLength(encodeGatewayCursor('f'.repeat(22), parts)) > MAX_EVENTS_CURSOR_BYTES) {
      return parts.size - 1;
    }
  }
})();
