// Shared App Server client for the server-queue runs.
import { appendFileSync } from 'node:fs';

export interface Client {
  sendRequest: (method: string, params: unknown) => Promise<any>;
  waitFor: (pred: (n: any) => boolean, ms: number) => Promise<any>;
  seen: any[];
  close: () => void;
}

/**
 * Opens one App Server client over WebSocket, logs requests, responses and
 * the notifications the runs care about, and initializes it with the
 * experimental API on.
 */
export async function openClient(url: string, log: string, tag: string): Promise<Client> {
  const ws = new WebSocket(url);

  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(new Error(`connect ${url}: ${String(e)}`));
  });

  let next = 1;

  const pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();

  const seen: any[] = [];
  const waiters: { pred: (n: any) => boolean; res: (v: any) => void }[] = [];
  const writeLine = (line: string) => appendFileSync(log, `${formatStamp()} [${tag}] ${line}\n`);

  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));

    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;

      pending.delete(msg.id);

      writeLine(`<- #${msg.id} ${JSON.stringify(msg.error ?? msg.result).slice(0, 700)}`);

      if (msg.error) p.rej(msg.error);
      else p.res(msg.result);

      return;
    }

    if (msg.method) {
      const brief = formatNotification(msg);

      if (brief) writeLine(`!! ${brief}`);

      seen.push(msg);

      for (const w of [...waiters]) {
        if (w.pred(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.res(msg);
        }
      }
    }
  };

  const sendRequest = (method: string, params: unknown) => {
    const id = next++;

    writeLine(`-> #${id} ${method} ${JSON.stringify(params).slice(0, 400)}`);

    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };

  const waitFor = (pred: (n: any) => boolean, ms: number) => {
    const hit = seen.find(pred);

    if (hit) return Promise.resolve(hit);

    return new Promise((res, rej) => {
      const w = { pred, res };

      waiters.push(w);

      setTimeout(() => {
        const i = waiters.indexOf(w);

        if (i >= 0) {
          waiters.splice(i, 1);

          rej(new Error(`timeout after ${ms} ms`));
        }
      }, ms);
    });
  };

  await sendRequest('initialize', {
    clientInfo: { name: 'geo930-run', title: null, version: '1' },
    capabilities: { experimentalApi: true },
  });

  return { sendRequest, waitFor, seen, close: () => ws.close() };
}

export function formatStamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function formatNotification(msg: any): string | null {
  const p = msg.params ?? {};

  switch (msg.method) {
    case 'turn/started':
      return `turn/started ${p.turn?.id}`;
    case 'turn/completed':
      return `turn/completed ${p.turn?.id} ${p.turn?.status}`;
    case 'thread/queue/changed':
      return `thread/queue/changed ${p.threadId}`;
    case 'item/completed': {
      const it = p.item ?? {};

      if (it.type === 'userMessage')
        return `item/completed userMessage turn=${p.turnId} clientId=${it.clientId} text=${JSON.stringify(it.content?.[0]?.text ?? '').slice(0, 80)}`;

      if (it.type === 'agentMessage')
        return `item/completed agentMessage turn=${p.turnId} phase=${it.phase} text=${JSON.stringify(it.text ?? '').slice(0, 80)}`;

      return null;
    }
    case 'thread/status/changed':
      return `thread/status/changed ${p.threadId} ${JSON.stringify(p.status)}`;
    default:
      return null;
  }
}

export function buildText(t: string) {
  return [{ type: 'text', text: t, text_elements: [] }];
}
