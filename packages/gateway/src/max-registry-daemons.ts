import { encodeCursor } from '@atc/protocol';
import { encodeGatewayCursor } from './encode-gateway-cursor';
import { MAX_EVENTS_CURSOR_BYTES } from './max-events-cursor-bytes';

export const MAX_REGISTRY_DAEMONS = (() => {
  // the worst case: every name at the longest allowed length, a position at the largest
  // event id, under the longest filter hash, so any cursor a registry this size makes decodes
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
