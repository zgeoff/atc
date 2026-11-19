export function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  const bytes = Buffer.from(text, 'utf8');

  // The cut leaves room for the three-byte ellipsis, or drops the ellipsis
  // when the cap is smaller than it, and backs up off any continuation byte
  // so it never lands inside a code point.
  const hasRoomForEllipsis = maxBytes >= 3;
  let end = hasRoomForEllipsis ? maxBytes - 3 : Math.max(maxBytes, 0);

  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }

  const head = bytes.subarray(0, end).toString('utf8');

  return hasRoomForEllipsis ? `${head}…` : head;
}
