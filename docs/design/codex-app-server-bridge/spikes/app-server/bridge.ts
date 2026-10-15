// Spike prototype: an external atc bridge for one Codex thread on App Server.
// Usage: bun bridge.ts <ws-url> <atc-session-id> <state-dir> [thread-id] [ctl-port]
// Control over HTTP on 127.0.0.1:<ctl-port>: POST /send {id,from,text}, /drop, /reconnect, /rpc, GET /.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

interface ThreadItem {
  type: string;
  clientId?: string | null;
  text?: string;
  content?: { text?: string }[];
}

interface Turn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  items: ThreadItem[];
}

interface WireParams {
  threadId?: string;
  turnId?: string;
  turn?: Turn;
  item?: ThreadItem;
  tool?: string;
  arguments?: Record<string, string>;
}

interface WireResult {
  thread?: { id: string; status?: { type: string } };
  turn?: Turn;
  turnId?: string;
  data?: Turn[];
}

interface WireMessage {
  id?: number | string;
  method?: string;
  params?: WireParams;
  result?: WireResult;
  error?: { code: number; message: string };
}

interface Pending {
  id: string;
  from: string;
  text: string;
  status: 'queued' | 'sent' | 'consumed' | 'answered' | 'unanswered';
  turnID?: string;
  via?: string;
  answer?: string;
  reason?: string;
}

const [url, atcSessionID, stateDir, threadArg, portArg] = process.argv.slice(2);
const statePath = `${stateDir}/bridge-state.json`;
const logPath = `${stateDir}/events.jsonl`;

const state: { threadID?: string; atcSessionID: string; messages: Record<string, Pending> } =
  existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { atcSessionID, messages: {} };

let ws: WebSocket;
let nextRequestID = 1;

const waiting = new Map<number | string, (msg: WireMessage) => void>();

let activeTurnID: string | undefined;

const lastAgentText = new Map<string, string>();

let draining = false;
const instructions = `This thread is atc session ${atcSessionID}. Messages from other atc sessions arrive wrapped in <atc-message id=".." from=".."> tags. Answer one with the atc.answer tool when you want to answer it before your turn ends; otherwise your final reply of the turn becomes its answer. Call atc.note with a short progress note at each milestone.`;

const dynamicTools = [
  {
    type: 'namespace',
    name: 'atc',
    description: 'atc control tower tools for this session.',
    tools: [
      {
        type: 'function',
        name: 'note',
        description: "Add a short progress note to atc's event feed. It does not answer a message.",
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' }, label: { type: 'string' } },
          required: ['text'],
        },
      },
      {
        type: 'function',
        name: 'answer',
        description: 'Answer one <atc-message> by its id. The answer reaches its sender.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' }, text: { type: 'string' } },
          required: ['id', 'text'],
        },
      },
    ],
  },
];

await openConnection();

if (threadArg) {
  await reconcileMessages();
  await drainQueue();
}

Bun.serve({
  port: Number(portArg ?? 47_173),
  hostname: '127.0.0.1',
  async fetch(req) {
    const path = new URL(req.url).pathname;

    if (path === '/send') {
      const body: Pending = await req.json();

      state.messages[body.id] ??= { ...body, status: 'queued' };

      writeState();

      if (state.messages[body.id].status === 'queued') {
        await sendMessage(state.messages[body.id]);
      }

      return Response.json(state.messages[body.id]);
    }

    if (path === '/drop') {
      ws.close();

      return Response.json({ dropped: true });
    }

    if (path === '/reconnect') {
      await openConnection();
      await reconcileMessages();
      await drainQueue();

      return Response.json({ threadID: state.threadID, activeTurnID });
    }

    if (path === '/rpc') {
      const body: { method: string; params: unknown } = await req.json();
      const res = await sendRequest(body.method, body.params);

      return Response.json(res);
    }

    return Response.json({ ...state, activeTurnID });
  },
});

async function openConnection() {
  ws = new WebSocket(url);

  ws.addEventListener('message', (ev) => {
    const msg: WireMessage = JSON.parse(String(ev.data));

    logEvent('in', msg);

    if (msg.id === undefined) {
      applyNotification(msg);
    } else if (msg.method) {
      answerServerRequest(msg);
    } else {
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });

  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true });
  });

  await sendRequest('initialize', {
    clientInfo: { name: 'atc-bridge-spike', title: null, version: '0.0.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });

  const threadID = threadArg || state.threadID;

  if (threadID) {
    const res = await sendRequest('thread/resume', { threadId: threadID, excludeTurns: true });

    state.threadID = res.result?.thread?.id ?? threadID;
    activeTurnID = undefined;

    if (res.result?.thread?.status?.type === 'active') {
      const turns = await sendRequest('thread/turns/list', {
        threadId: threadID,
        limit: 1,
        sortDirection: 'desc',
      });

      activeTurnID = turns.result?.data?.[0]?.id;
    }
  } else {
    const res = await sendRequest('thread/start', {
      cwd: `${stateDir}/work`,
      developerInstructions: instructions,
      dynamicTools,
    });

    state.threadID = res.result?.thread?.id;
  }

  writeState();

  console.log(JSON.stringify({ threadID: state.threadID, activeTurnID }));
}

// After a reconnect, settle each open message from the thread's stored turns. The userMessage
// item's clientId matches the message id, so a resend never duplicates a message the server took.
async function reconcileMessages() {
  const res = await sendRequest('thread/turns/list', {
    threadId: state.threadID,
    limit: 20,
    itemsView: 'full',
  });

  const turns = res.result?.data ?? [];

  for (const m of Object.values(state.messages)) {
    if (m.status === 'answered' || m.status === 'unanswered') {
      continue;
    }

    const turn = turns.find((t) =>
      t.items.some((i) => i.type === 'userMessage' && i.clientId === m.id),
    );

    if (!turn) {
      Object.assign(m, { status: 'queued', turnID: undefined });
      continue;
    }

    m.turnID = turn.id;

    if (turn.status === 'inProgress') {
      m.status = 'consumed';
      continue;
    }

    const agentTexts = turn.items.filter((i) => i.type === 'agentMessage').map((i) => i.text);

    if (turn.status === 'completed') {
      Object.assign(m, {
        status: 'answered',
        via: 'final-reply-reconciled',
        answer: agentTexts.at(-1) ?? '',
      });
    } else {
      Object.assign(m, { status: 'unanswered', reason: turn.status });
    }
  }

  writeState();
}

function logEvent(dir: string, msg: WireMessage) {
  appendFileSync(logPath, `${JSON.stringify({ conn: 'bridge', dir, msg })}\n`);
}

function answerServerRequest(msg: WireMessage) {
  // Approvals and user-input requests belong to the terminal. The first client to answer one
  // wins, so the bridge leaves every request other than its own tool calls unanswered.
  if (msg.method !== 'item/tool/call') {
    return;
  }

  const params = msg.params ?? {};
  const args = params.arguments ?? {};

  if (params.tool === 'note') {
    const note = { turnID: params.turnId, ...args };

    appendFileSync(`${stateDir}/notes.jsonl`, `${JSON.stringify(note)}\n`);
    sendResponse(msg.id, { success: true, contentItems: [{ type: 'inputText', text: 'noted' }] });
  } else if (params.tool === 'answer') {
    const m = state.messages[args.id];

    if (m && m.status !== 'answered') {
      Object.assign(m, { status: 'answered', via: 'tool', answer: args.text });

      writeState();
    }

    const text = m ? 'answered' : 'no such message';

    sendResponse(msg.id, { success: Boolean(m), contentItems: [{ type: 'inputText', text }] });
  }
}

function sendResponse(id: WireMessage['id'], result: unknown) {
  const msg = { id, result };

  logEvent('out', msg as WireMessage);

  ws.send(JSON.stringify(msg));
}

function writeState() {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function applyNotification(msg: WireMessage) {
  const p = msg.params ?? {};

  if (p.threadId && p.threadId !== state.threadID) {
    return;
  }

  if (msg.method === 'turn/started' && p.turn) {
    activeTurnID = p.turn.id;
  }

  if (msg.method === 'turn/completed' && p.turn) {
    if (activeTurnID === p.turn.id) {
      activeTurnID = undefined;
    }

    updateMessagesForTurn(p.turn);
    void drainQueue();
  }

  if (msg.method !== 'item/completed' || !p.item || !p.turnId) {
    return;
  }

  if (p.item.type === 'agentMessage') {
    lastAgentText.set(p.turnId, p.item.text ?? '');
  }

  if (p.item.type === 'userMessage') {
    const text = (p.item.content ?? []).map((c) => c.text ?? '').join('');

    for (const match of text.matchAll(/<atc-message id="(?<id>[^"]+)"/g)) {
      const m = state.messages[match.groups?.id ?? ''];

      if (m && (m.status === 'sent' || m.status === 'queued')) {
        Object.assign(m, { status: 'consumed', turnID: p.turnId });
      }
    }

    writeState();
  }
}

function updateMessagesForTurn(turn: Turn) {
  for (const m of Object.values(state.messages)) {
    if (m.turnID !== turn.id || m.status === 'answered' || m.status === 'unanswered') {
      continue;
    }

    if (turn.status === 'completed' && m.status === 'consumed') {
      const answer = lastAgentText.get(turn.id) ?? '';

      Object.assign(m, { status: 'answered', via: 'final-reply', answer });
    } else if (m.status === 'consumed') {
      Object.assign(m, { status: 'unanswered', reason: turn.status });
    } else {
      // Accepted but never recorded in the turn: send it again on the next turn.
      Object.assign(m, { status: 'queued', turnID: undefined });
    }
  }

  writeState();
}

async function drainQueue() {
  if (draining) {
    return;
  }

  draining = true;

  try {
    for (const m of Object.values(state.messages)) {
      if (m.status === 'queued') {
        await sendMessage(m);
      }
    }
  } finally {
    draining = false;
  }
}

async function sendMessage(m: Pending) {
  const input = [{ type: 'text', text: buildEnvelope(m), text_elements: [] }];

  if (activeTurnID) {
    const steer = await sendRequest('turn/steer', {
      threadId: state.threadID,
      input,
      clientUserMessageId: m.id,
      expectedTurnId: activeTurnID,
    });

    if (!steer.error) {
      Object.assign(m, { status: 'sent', turnID: steer.result?.turnId, via: 'steer' });

      writeState();

      return;
    }
  }

  const res = await sendRequest('turn/start', {
    threadId: state.threadID,
    input,
    clientUserMessageId: m.id,
    effort: 'low',
  });

  if (res.error) {
    return;
  }

  Object.assign(m, { status: 'sent', turnID: res.result?.turn?.id, via: 'start' });

  writeState();
}

function buildEnvelope(m: Pending) {
  return `<atc-message id="${m.id}" from="${m.from}">\n${m.text}\n</atc-message>`;
}

function sendRequest(method: string, params: unknown): Promise<WireMessage> {
  const id = nextRequestID;

  nextRequestID += 1;

  const msg = { id, method, params };

  logEvent('out', msg as WireMessage);

  ws.send(JSON.stringify(msg));

  return new Promise((resolve) => {
    waiting.set(id, resolve);
  });
}
