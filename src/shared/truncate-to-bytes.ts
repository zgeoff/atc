export function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  const bytes = Buffer.from(text, 'utf8');

  // The cut leaves room for the three-byte ellipsis and backs up off any
  // continuation byte so it never lands inside a code point.
  let end = maxBytes - 3;

  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }

  return `${bytes.subarray(0, end).toString('utf8')}…`;
}
