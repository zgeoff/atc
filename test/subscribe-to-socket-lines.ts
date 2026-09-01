interface SocketLines {
  readonly lines: string[];
  readonly write: (data: string) => void;
  readonly waitForLine: (count?: number, timeoutMs?: number) => Promise<string[]>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * Connects to a unix socket and collects every complete newline-terminated
 * line it sends, buffering a partial line across reads. `waitForLine` polls
 * until the collected count reaches `count` and returns the lines, throwing
 * when `timeoutMs` passes first; disposal ends the connection.
 */
export async function subscribeToSocketLines(path: string): Promise<SocketLines> {
  const lines: string[] = [];
  let buffer = '';

  const socket = await Bun.connect({
    unix: path,
    socket: {
      data(_s, buf) {
        buffer += buf.toString();

        const parts = buffer.split('\n');

        buffer = parts.pop() ?? '';

        lines.push(...parts.filter((part) => part.trim() !== ''));
      },
      close() {},
      error() {},
    },
  });

  return {
    lines,
    write(data: string) {
      socket.write(data);
    },
    async waitForLine(count = 1, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;

      while (lines.length < count && Date.now() < deadline) {
        await Bun.sleep(10);
      }

      if (lines.length < count) {
        throw new Error(`timed out waiting for ${count} lines; got ${JSON.stringify(lines)}`);
      }

      return lines;
    },
    [Symbol.asyncDispose]: () => {
      socket.end();

      return Promise.resolve();
    },
  };
}
