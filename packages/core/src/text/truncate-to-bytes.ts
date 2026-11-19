export function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  const bytes = Buffer.from(text, 'utf8');

  // '…' takes three bytes in UTF-8, and a byte of the form 10xxxxxx continues a code point,
  // so a cut there would split a character.
  const hasRoomForEllipsis = maxBytes >= 3;
  let end = hasRoomForEllipsis ? maxBytes - 3 : Math.max(maxBytes, 0);

  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }

  const head = bytes.subarray(0, end).toString('utf8');

  return hasRoomForEllipsis ? `${head}…` : head;
}
