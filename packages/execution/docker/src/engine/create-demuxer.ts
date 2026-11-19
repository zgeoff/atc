import type { StreamName } from './types';

const HEADER_BYTES = 8;

interface Demuxer {
  // takes the next bytes of a multiplexed stream and reports each whole frame's payload
  readonly feed: (chunk: Uint8Array) => void;
}

// The Engine's multiplexed stream for a container without a terminal: frames of an 8-byte header
// (the stream, three zero bytes, the payload size as a big-endian number) and the payload.
export function createDemuxer(onFrame: (data: Uint8Array, stream: StreamName) => void): Demuxer {
  let pending = new Uint8Array(0);

  return {
    feed: (chunk) => {
      const merged = new Uint8Array(pending.length + chunk.length);

      merged.set(pending);
      merged.set(chunk, pending.length);

      let offset = 0;

      while (merged.length - offset >= HEADER_BYTES) {
        const view = new DataView(merged.buffer, merged.byteOffset + offset, HEADER_BYTES);

        const size = view.getUint32(4);
        const end = offset + HEADER_BYTES + size;

        if (end > merged.length) {
          break;
        }

        const stream: StreamName = view.getUint8(0) === 2 ? 'stderr' : 'stdout';

        onFrame(merged.slice(offset + HEADER_BYTES, end), stream);

        offset = end;
      }

      pending = merged.slice(offset);
    },
  };
}
