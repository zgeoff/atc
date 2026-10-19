import { z } from 'zod';

// Starts a thread on a Codex App Server from a client of its own, as the
// terminal does when it opens a new conversation, and resolves with the
// thread's id once the client has closed.
export async function startCodexTerminalThread(socket: string): Promise<string> {
  const ws = new WebSocket(`ws+unix://${socket}`);
  const answers = new Map<number, (value: unknown) => void>();
  const rejections = new Set<(error: Error) => void>();

  let failure: Error | null = null;

  // A connection that fails or closes rejects every wait on it, so a missing
  // or broken server fails the caller at once with the cause.
  const endConnection = (error: Error) => {
    failure ??= error;

    for (const reject of rejections) {
      reject(failure);
    }

    rejections.clear();
  };

  const waitUntil = <T>(start: (resolve: (value: T) => void) => void) =>
    new Promise<T>((resolve, reject) => {
      if (failure !== null) {
        reject(failure);

        return;
      }

      rejections.add(reject);

      start((value) => {
        rejections.delete(reject);

        resolve(value);
      });
    });

  ws.addEventListener('error', () => {
    endConnection(new Error(`the App Server connection at ${socket} failed`));
  });

  ws.addEventListener('close', () => {
    endConnection(new Error(`the App Server at ${socket} closed the connection before answering`));
  });

  ws.addEventListener('message', (event) => {
    const line = z
      .looseObject({ id: z.unknown(), result: z.unknown() })
      .safeParse(JSON.parse(String(event.data)));

    if (line.success && typeof line.data.id === 'number') {
      answers.get(line.data.id)?.(line.data.result);
    }
  });

  const sendRequest = (id: number, method: string, params: unknown) =>
    waitUntil<unknown>((resolve) => {
      answers.set(id, resolve);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });

  try {
    await waitUntil<unknown>((resolve) => {
      ws.addEventListener('open', resolve, { once: true });
    });

    await sendRequest(1, 'initialize', { clientInfo: { name: 'terminal', version: '1' } });

    const started = await sendRequest(2, 'thread/start', {});

    return z.object({ thread: z.object({ id: z.string() }) }).parse(started).thread.id;
  } finally {
    ws.close();
  }
}
