/**
 * Reads a byte stream as UTF-8 text, giving up once it passes `maxBytes`:
 * the stream is cancelled at that point and the result is null, so an
 * oversized body is never held in memory whole.
 */
export async function readBoundedText(
  stream: Readonly<ReadableStream<Uint8Array>>,
  maxBytes: number,
): Promise<string | null> {
  const reader = stream.getReader();

  const decoder = new TextDecoder('utf-8');

  let total = 0;
  let text = '';

  for (;;) {
    const chunk = await reader.read();

    if (chunk.done) {
      return text + decoder.decode();
    }

    total += chunk.value.byteLength;

    if (total > maxBytes) {
      await reader.cancel();

      return null;
    }

    text += decoder.decode(chunk.value, { stream: true });
  }
}
