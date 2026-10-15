// Probe: drives one App Server thread through a scenario and logs every wire message.
// Usage: bun probe.ts <ws-url> <scenario> <log-file> [thread-id] [raw:0|1]
import { appendFileSync } from 'node:fs';

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: any };

const [url, scenario, logFile, threadArg, rawArg] = process.argv.slice(2);
const raw = rawArg !== '0';
const t0 = Date.now();
let nextID = 1;
const waiting = new Map<number, (m: Msg) => void>();
const listeners: ((m: Msg) => void)[] = [];

function logWire(dir: string, m: unknown): void {
  appendFileSync(logFile, JSON.stringify({ ms: Date.now() - t0, dir, m }) + '\n');
}

const ws = new WebSocket(url);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
ws.addEventListener('message', (ev) => {
  const m: Msg = JSON.parse(String(ev.data));
  logWire('in', m);
  if (m.id !== undefined && m.method === undefined) {
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  }
  for (const l of [...listeners]) l(m);
});

function sendRequest(method: string, params: unknown): Promise<Msg> {
  const id = nextID++;
  const m = { jsonrpc: '2.0', id, method, params };
  logWire('out', m);
  ws.send(JSON.stringify(m));
  return new Promise((r) => waiting.set(id, r));
}

function waitForMessage(pred: (m: Msg) => boolean, ms = 180_000): Promise<Msg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    const l = (m: Msg): void => {
      if (pred(m)) {
        clearTimeout(timer);
        listeners.splice(listeners.indexOf(l), 1);
        resolve(m);
      }
    };
    listeners.push(l);
  });
}

const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

await sendRequest('initialize', {
  clientInfo: { name: 'read-probe', title: null, version: '0.0.0' },
  capabilities: { experimentalApi: true },
});
ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }));

let threadID = threadArg;
if (threadID) {
  const r = await sendRequest('thread/resume', { threadId: threadID, excludeTurns: true });
  if (r.error) throw new Error(JSON.stringify(r.error));
} else {
  const r = await sendRequest('thread/start', {
    cwd: `${import.meta.dir}/work`,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    ...(raw ? { experimentalRawEvents: true } : {}),
  });
  threadID = r.result.thread.id;
}
console.log(`thread ${threadID}`);

const isTurnDone = (m: Msg) => m.method === 'turn/completed' && m.params?.threadId === threadID;
const isItemStarted = (type: string) => (m: Msg) =>
  m.method === 'item/started' && m.params?.threadId === threadID && m.params.item?.type === type;

function sendMessage(id: string, text: string): Promise<Msg> {
  return sendRequest('turn/start', {
    threadId: threadID,
    clientUserMessageId: id,
    input: [{ type: 'text', text, text_elements: [] }],
  });
}

const LONG = 'Write about 250 words on ocean tides. Do not use tools.';
const CMD = 'Run the shell command `sleep 12` once, then reply with the single word DONE.';

switch (scenario) {
  case 'idle': {
    await sendMessage('m-idle', 'Reply with the single word KIWI.');
    await waitForMessage(isTurnDone);
    break;
  }
  case 'steer-stream': {
    await sendMessage('m-s1', LONG);
    let deltas = 0;
    await waitForMessage((m) => m.method === 'item/agentMessage/delta' && ++deltas >= 20);
    await sendMessage('m-s2', 'Also end your reply with the single word MANGO.');
    await waitForMessage(isTurnDone);
    break;
  }
  case 'steer-early': {
    await sendMessage('m-e1', LONG);
    await waitForMessage(isItemStarted('userMessage'));
    await sendMessage('m-e2', 'Also end your reply with the single word GUAVA.');
    await waitForMessage(isTurnDone);
    break;
  }
  case 'interrupt-pending': {
    const r = await sendMessage('m-p1', LONG);
    await waitForMessage(isItemStarted('userMessage'));
    await sendMessage('m-p2', 'Also end your reply with the single word QUINCE.');
    await waitMs(500);
    await sendRequest('turn/interrupt', { threadId: threadID, turnId: r.result.turn.id });
    await waitForMessage(isTurnDone);
    const list = await sendRequest('thread/turns/list', { threadId: threadID, limit: 5, itemsView: 'full' });
    console.log(JSON.stringify(list.result.data.map((t: any) => ({ status: t.status, items: t.items.map((i: any) => `${i.type}:${i.clientId ?? ''}`) }))));
    await waitMs(2000);
    await sendMessage('m-p3', 'Reply with the single word KIWI.');
    await waitForMessage(isTurnDone);
    break;
  }
  case 'steer-command': {
    await sendMessage('m-c1', CMD);
    await waitForMessage(isItemStarted('commandExecution'));
    await waitMs(3000);
    await sendMessage('m-c2', 'Also add the single word PEAR to your reply.');
    await waitForMessage(isTurnDone);
    break;
  }
  case 'interrupt-command': {
    const r = await sendMessage('m-i1', CMD);
    await waitForMessage(isItemStarted('commandExecution'));
    await waitMs(3000);
    await sendMessage('m-i2', 'Also add the single word PLUM to your reply.');
    await waitMs(1500);
    await sendRequest('turn/interrupt', { threadId: threadID, turnId: r.result.turn.id });
    await waitForMessage(isTurnDone);
    break;
  }
  case 'interrupt-stream': {
    const r = await sendMessage('m-j1', LONG);
    let deltas = 0;
    await waitForMessage((m) => m.method === 'item/agentMessage/delta' && ++deltas >= 20);
    await sendMessage('m-j2', 'Also end your reply with the single word FIG.');
    await waitMs(300);
    await sendRequest('turn/interrupt', { threadId: threadID, turnId: r.result.turn.id });
    await waitForMessage(isTurnDone);
    break;
  }
  case 'list': {
    const r = await sendRequest('thread/turns/list', { threadId: threadID, limit: 20, itemsView: 'full' });
    console.log(JSON.stringify(r.result ?? r.error));
    break;
  }
  case 'idle-hold': {
    await sendMessage('m-h1', 'Reply with the single word KIWI.');
    await waitForMessage(isTurnDone);
    await waitMs(Number(process.env.OBSERVE_MS ?? 60_000));
    await sendMessage('m-h2', 'Run the shell command `sleep 5` once, then reply with the single word LIME.');
    await waitForMessage(isTurnDone);
    break;
  }
  case 'observe': {
    await waitMs(Number(process.env.OBSERVE_MS ?? 60_000));
    break;
  }
}
await waitMs(1500);
ws.close();
process.exit(0);
