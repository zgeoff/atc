export interface LineDecoder {
  readonly splitChunk: (bytes: Uint8Array) => string[];
}

// One JSON message per line, as the protocol frames it. A chunk can end inside a line, so the
// decoder keeps the tail for the next chunk.
export function createLineDecoder(): LineDecoder {
  const decoder = new TextDecoder();

  let pending = '';

  return {
    splitChunk: (bytes) => {
      const lines = `${pending}${decoder.decode(bytes, { stream: true })}`.split('\n');

      pending = lines.pop() ?? '';

      return lines.filter((line) => line.trim() !== '');
    },
  };
}
