import { z } from 'zod';

// Starts a thread on a Codex App Server from a client of its own, as the
// terminal does when it opens a new conversation, and resolves with the
// thread's id once the client has closed.
export async function startCodexTerminalThread(socket: string): Promise<string> {
  const ws = new WebSocket(`ws+unix://${socket}`);
  const answers = new Map<number, (value: unknown) => void>();

  ws.addEventListener('message', (event) => {
    const line = z
      .looseObject({ id: z.unknown(), result: z.unknown() })
      .safeParse(JSON.parse(String(event.data)));

    if (line.success && typeof line.data.id === 'number') {
      answers.get(line.data.id)?.(line.data.result);
    }
  });

  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true });
  });

  const sendRequest = (id: number, method: string, params: unknown) =>
    new Promise<unknown>((resolve) => {
      answers.set(id, resolve);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });

  await sendRequest(1, 'initialize', { clientInfo: { name: 'terminal', version: '1' } });

  const started = await sendRequest(2, 'thread/start', {});

  ws.close();

  return z.object({ thread: z.object({ id: z.string() }) }).parse(started).thread.id;
}
