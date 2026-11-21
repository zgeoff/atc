// A chunk never ends between the two halves of a surrogate pair, which JSON cannot carry apart.
export function splitReplayChunks(replay: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let offset = 0;

  while (offset < replay.length) {
    let end = Math.min(offset + maxLength, replay.length);
    const last = replay.codePointAt(end - 1) ?? 0;

    if (end < replay.length && last > 0xff_ff) {
      end -= 1;
    }

    chunks.push(replay.slice(offset, end));

    offset = end;
  }

  return chunks.length === 0 ? [''] : chunks;
}
