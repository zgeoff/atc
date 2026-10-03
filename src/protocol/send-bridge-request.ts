import { randomUUID } from 'node:crypto';
import { openBridgeSocket } from './open-bridge-socket';

/**
 * Sends one request to the session bridge at a unix socket path and
 * returns its answer line, or null when nothing listens there, the
 * connection closes first, or no answer arrives in time. Never throws.
 */
export async function sendBridgeRequest(
  path: string,
  op: string,
  args: Readonly<Record<string, unknown>>,
  timeoutMs: number,
): Promise<Readonly<Record<string, unknown>> | null> {
  const id = randomUUID();
  const answered = Promise.withResolvers<Readonly<Record<string, unknown>> | null>();

  try {
    const socket = await openBridgeSocket(path, (line) => {
      if (line['id'] === id) {
        answered.resolve(line);
      }
    });

    void (async () => {
      await socket.closed;

      answered.resolve(null);
    })();

    const timer = setTimeout(() => {
      answered.resolve(null);
    }, timeoutMs);

    socket.writeLine({ ...args, v: 1, id, op });

    const answer = await answered.promise;

    clearTimeout(timer);

    socket.end();

    return answer;
  } catch {
    return null;
  }
}
