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
