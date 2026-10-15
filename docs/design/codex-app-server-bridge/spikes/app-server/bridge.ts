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
  nextCursor?: string | null;
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
  status: 'queued' | 'sent' | 'recorded' | 'consumed' | 'answered' | 'unanswered';
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

const sending = new Set<string>();

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

const resumed = await openConnection();

if (resumed) {
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

    writeState();

    console.log(JSON.stringify({ threadID: state.threadID, activeTurnID }));

    return true;
  }

  const res = await sendRequest('thread/start', {
    cwd: `${stateDir}/work`,
    developerInstructions: instructions,
    dynamicTools,
  });

  state.threadID = res.result?.thread?.id;

  // A new thread has no rollout until its first turn, and the terminal cannot resume a thread
  // without one. One injected developer item writes the rollout with no model turn.
  await sendRequest('thread/inject_items', {
    threadId: state.threadID,
    items: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: `atc bridge attached for session ${atcSessionID}.` }],
      },
    ],
  });

  writeState();

  console.log(JSON.stringify({ threadID: state.threadID, activeTurnID }));

  return false;
}

// After a reconnect, settle each open message from the thread's stored turns. The userMessage
// item's clientId matches the message id, so a resend never duplicates a message the server took.
async function reconcileMessages() {
  const turns = await collectTurnsHoldingOpenMessages();

  for (const m of Object.values(state.messages)) {
    if (m.status === 'answered' || m.status === 'unanswered') {
      continue;
    }

    const turn = turns.find((t) => t.items.some((i) => isMessageItem(i, m.id)));

    if (!turn) {
      Object.assign(m, { status: 'queued', turnID: undefined });
      continue;
    }

    m.turnID = turn.id;

    const index = turn.items.findIndex((i) => isMessageItem(i, m.id));
    const seen = turn.items.slice(index + 1).some((i) => i.type !== 'userMessage');
    const agentTexts = turn.items.filter((i) => i.type === 'agentMessage').map((i) => i.text);

    if (turn.status === 'inProgress') {
      m.status = seen ? 'consumed' : 'recorded';

      const last = agentTexts.at(-1);

      if (last !== undefined) {
        lastAgentText.set(turn.id, last);
      }

      continue;
    }

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

// Pages back through the thread's turns, newest first, until every open message has its turn or
// the history ends, so a message the server took long ago is never mistaken for an unsent one.
async function collectTurnsHoldingOpenMessages() {
  const open = new Set(
    Object.values(state.messages)
      .filter((m) => m.status !== 'answered' && m.status !== 'unanswered')
      .map((m) => m.id),
  );

  const turns: Turn[] = [];
  let cursor: string | null | undefined;

  while (open.size > 0) {
    const res = await sendRequest('thread/turns/list', {
      threadId: state.threadID,
      limit: 20,
      itemsView: 'full',
      cursor,
    });

    const page = res.result?.data ?? [];

    turns.push(...page);

    for (const item of page.flatMap((t) => t.items)) {
      open.delete(item.clientId ?? '');
    }

    cursor = res.result?.nextCursor;

    if (!cursor) {
      break;
    }
  }

  return turns;
}

function isMessageItem(item: ThreadItem, messageID: string) {
  return item.type === 'userMessage' && item.clientId === messageID;
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

  if (!p.item || !p.turnId) {
    return;
  }

  // A model item that starts after a recorded message is the spike's sign that the model read it.
  // A response already streaming when the input was recorded can also start one, so the sign only
  // labels why an interrupted turn left a message unanswered.
  if (msg.method === 'item/started' && p.item.type !== 'userMessage') {
    for (const m of Object.values(state.messages)) {
      if (m.turnID === p.turnId && m.status === 'recorded') {
        m.status = 'consumed';
      }
    }

    writeState();
  }

  if (msg.method !== 'item/completed') {
    return;
  }

  if (p.item.type === 'agentMessage') {
    lastAgentText.set(p.turnId, p.item.text ?? '');
  }

  const m = p.item.type === 'userMessage' ? state.messages[p.item.clientId ?? ''] : undefined;

  if (m && (m.status === 'queued' || m.status === 'sent')) {
    Object.assign(m, { status: 'recorded', turnID: p.turnId });

    writeState();
  }
}

function updateMessagesForTurn(turn: Turn) {
  for (const m of Object.values(state.messages)) {
    if (m.turnID !== turn.id || m.status === 'answered' || m.status === 'unanswered') {
      continue;
    }

    const isInTurn = m.status === 'recorded' || m.status === 'consumed';

    if (turn.status === 'completed' && isInTurn) {
      const answer = lastAgentText.get(turn.id) ?? '';

      Object.assign(m, { status: 'answered', via: 'final-reply', answer });
    } else if (isInTurn) {
      const reason = m.status === 'recorded' ? `${turn.status}-unseen` : turn.status;

      Object.assign(m, { status: 'unanswered', reason });
    } else if (!sending.has(m.id)) {
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

// `turn/start` opens a turn on an idle thread and joins the active turn otherwise, returning the
// turn that carries the message either way, so delivery needs no separate steer.
async function sendMessage(m: Pending) {
  if (sending.has(m.id) || m.status !== 'queued') {
    return;
  }

  sending.add(m.id);

  const turnBefore = activeTurnID;

  try {
    const res = await sendRequest('turn/start', {
      threadId: state.threadID,
      input: [{ type: 'text', text: buildEnvelope(m), text_elements: [] }],
      clientUserMessageId: m.id,
      effort: 'low',
    });

    if (res.error) {
      return;
    }

    // The userMessage item can arrive before this response, so only a message still queued
    // moves to sent; a later state stays.
    m.turnID ??= res.result?.turn?.id;
    m.via = res.result?.turn?.id === turnBefore ? 'start-joined' : 'start';

    if (m.status === 'queued') {
      m.status = 'sent';
    }

    writeState();
  } finally {
    sending.delete(m.id);
  }
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
