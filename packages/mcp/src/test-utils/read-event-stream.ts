import invariant from 'tiny-invariant';

interface StreamMessage {
  readonly event: string;
  readonly id: string | null;
  readonly data: unknown;
}

interface StreamStop {
  readonly messages?: number;
  readonly comments?: number;
}

// Reads event stream messages from a response until it has the messages or the comments asked for,
// or the stream ends. Comment lines, such as a keep-alive, are no message; the number of them read
// so far comes back too.
export async function readEventStream(
  response: Response,
  stop: StreamStop,
): Promise<{ readonly messages: readonly StreamMessage[]; readonly comments: number }> {
  const reader = response.body?.getReader();

  if (reader === undefined) {
    return { messages: [], comments: 0 };
  }

  const decoder = new TextDecoder();

  const messages: StreamMessage[] = [];
  let comments = 0;
  let buffer = '';

  while (messages.length < (stop.messages ?? Infinity) && comments < (stop.comments ?? Infinity)) {
    const chunk = await reader.read();

    if (chunk.done) {
      break;
    }

    const bytes: unknown = chunk.value;

    invariant(bytes instanceof Uint8Array, 'a response streams bytes');

    buffer += decoder.decode(bytes, { stream: true });

    const blocks = buffer.split('\n\n');

    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      const lines = block.split('\n');

      if (lines.every((line) => line.startsWith(':'))) {
        comments += 1;
        continue;
      }

      const field = (name: string): string | null =>
        lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;

      const data = field('data');

      messages.push({
        event: field('event') ?? 'message',
        id: field('id'),
        data: data === null ? null : JSON.parse(data),
      });
    }
  }

  reader.releaseLock();

  return { messages, comments };
}
