const NEWLINE = 0x0a;

// Split on the newline byte before decoding: a chunk can cut a multi-byte character in two.
export function createByteLineSplitter(): (chunk: Uint8Array) => string[] {
  const decoder = new TextDecoder();
  let pending = new Uint8Array(0);

  return (chunk) => {
    const joined = new Uint8Array(pending.length + chunk.length);

    joined.set(pending, 0);
    joined.set(chunk, pending.length);

    const lines: string[] = [];
    let start = 0;

    for (
      let index = joined.indexOf(NEWLINE);
      index !== -1;
      index = joined.indexOf(NEWLINE, start)
    ) {
      const line = decoder.decode(joined.subarray(start, index));

      if (line.trim() !== '') {
        lines.push(line);
      }

      start = index + 1;
    }

    pending = joined.slice(start);

    return lines;
  };
}
