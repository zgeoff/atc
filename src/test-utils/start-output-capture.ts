/**
 * Reads the stream in the background and keeps every chunk it has read, as
 * text, in arrival order, until the stream ends. `read` returns all the text
 * read so far, so a test can wait on output from a process that never
 * exits.
 */
// oxlint-disable-next-line prefer-readonly-parameter-types -- reading a stream locks and drains it
export function startOutputCapture(stream: ReadableStream<Uint8Array>) {
  let text = '';

  const decoder = new TextDecoder();

  void (async () => {
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
    }
  })();

  return { read: () => text };
}
