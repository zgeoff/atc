import { rmSync } from 'node:fs';
import type { Server, ServerWebSocket } from 'bun';
import { z } from 'zod';

export const STUB_CODEX_APP_SERVER_SCENARIO_SCHEMA = z.object({
  reply: z.string().optional(),
  holdTurns: z.boolean().optional(),
  dropOnTurnStart: z.number().optional(),
  dropBeforeTurnStart: z.number().optional(),
  completeHeldTurnsOnResume: z.boolean().optional(),
  failTurnsListFrom: z.number().optional(),
  refuseTurnsListOf: z.array(z.string()).optional(),
  rejectTurnStarts: z.boolean().optional(),
  overloadTurnStarts: z.number().optional(),
});

export type StubCodexAppServerScenario = Readonly<
  z.output<typeof STUB_CODEX_APP_SERVER_SCENARIO_SCHEMA>
>;

export interface StubCodexAppServerRequest {
  readonly method: string;
  readonly params: unknown;
}

interface StubItem {
  readonly type: 'userMessage' | 'agentMessage';
  readonly id: string;
  readonly clientId?: string;
  readonly text: string;
  readonly phase?: 'final_answer';
}

interface StubTurn {
  readonly id: string;
  status: 'inProgress' | 'completed';
  readonly items: StubItem[];
}

interface StubThread {
  readonly id: string;
  readonly turns: StubTurn[];
}

const REQUEST_SCHEMA = z.looseObject({
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.unknown().optional(),
});

const RESPONSE_SCHEMA = z.looseObject({
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

const THREAD_PARAMS_SCHEMA = z.looseObject({ threadId: z.string() });
const INPUT_PART_SCHEMA = z.looseObject({ text: z.string() });

const TURN_START_PARAMS_SCHEMA = z.looseObject({
  threadId: z.string(),
  input: z.array(INPUT_PART_SCHEMA),
  clientUserMessageId: z.string().optional(),
});

const TURNS_LIST_PARAMS_SCHEMA = z.looseObject({
  threadId: z.string(),
  limit: z.number().optional(),
  cursor: z.string().nullish(),
});

export function startStubCodexAppServer(
  socket: string,
  scenario: StubCodexAppServerScenario,
  onRequest: (request: StubCodexAppServerRequest) => void = () => {},
) {
  const requests: StubCodexAppServerRequest[] = [];

  const threads = new Map<string, StubThread>();
  const connections = new Set<ServerWebSocket>();
  const toolCalls = new Map<string, (result: unknown) => void>();
  const connectionNumbers = new WeakMap<ServerWebSocket, number>();

  let latest: ServerWebSocket | null = null;
  let opened = 0;
  let counter = 0;
  let turnStarts = 0;
  let turnStartRequests = 0;
  let overloads = 0;

  const mintID = (prefix: string) => {
    counter += 1;

    return `${prefix}-${counter}`;
  };

  const emitNotification = (method: string, params: unknown) => {
    for (const ws of connections) {
      sendLine(ws, { method, params });
    }
  };

  const emitItem = (threadID: string, turnID: string, item: StubItem) => {
    emitNotification('item/started', { threadId: threadID, turnId: turnID, item });
    emitNotification('item/completed', { threadId: threadID, turnId: turnID, item });
  };

  const updateTurnCompleted = (thread: StubThread, turn: StubTurn) => {
    const reply: StubItem = {
      type: 'agentMessage',
      id: mintID('item'),
      text: scenario.reply ?? 'stub reply',
      phase: 'final_answer',
    };

    turn.items.push(reply);

    emitItem(thread.id, turn.id, reply);

    turn.status = 'completed';

    emitNotification('turn/completed', { threadId: thread.id, turn });
  };

  const startTurn = (thread: StubThread, text: string, clientID: string | undefined) => {
    // A turn/start on a thread with a turn in progress joins that turn, as Codex
    // does.
    const active = thread.turns.find((t) => t.status === 'inProgress');
    const turn = active ?? { id: mintID('turn'), status: 'inProgress' as const, items: [] };

    if (active === undefined) {
      thread.turns.push(turn);

      emitNotification('turn/started', { threadId: thread.id, turn });
    }

    const message: StubItem = {
      type: 'userMessage',
      id: mintID('item'),
      text,
      ...(clientID === undefined ? {} : { clientId: clientID }),
    };

    turn.items.push(message);

    emitItem(thread.id, turn.id, message);

    if (scenario.holdTurns !== true) {
      updateTurnCompleted(thread, turn);
    }

    return turn;
  };

  const findThread = (params: unknown): StubThread | null => {
    const parsed = THREAD_PARAMS_SCHEMA.safeParse(params);

    return parsed.success ? (threads.get(parsed.data.threadId) ?? null) : null;
  };

  const answerRequest = (
    ws: ServerWebSocket,
    method: string,
    params: unknown,
  ):
    | { readonly result: unknown }
    | { readonly error: { code: number; message: string } }
    | null => {
    if (method === 'initialize') {
      return { result: { userAgent: 'stub-codex-app-server' } };
    }

    if (method === 'thread/start') {
      const thread: StubThread = { id: mintID('thread'), turns: [] };

      threads.set(thread.id, thread);

      emitNotification('thread/started', { thread: { id: thread.id } });

      return { result: { thread: { id: thread.id, status: { type: 'idle' } } } };
    }

    const thread = findThread(params);

    if (thread === null) {
      // Codex fails a request for a thread it has not loaded with this code.
      return { error: { code: -32_600, message: 'thread not loaded' } };
    }

    if (method === 'thread/resume') {
      if (scenario.completeHeldTurnsOnResume === true) {
        for (const turn of thread.turns.filter((t) => t.status === 'inProgress')) {
          updateTurnCompleted(thread, turn);
        }
      }

      const active = thread.turns.some((t) => t.status === 'inProgress');

      return {
        result: { thread: { id: thread.id, status: { type: active ? 'active' : 'idle' } } },
      };
    }

    if (method === 'thread/inject_items') {
      return { result: {} };
    }

    if (method === 'thread/turns/list') {
      if (
        scenario.failTurnsListFrom !== undefined &&
        (connectionNumbers.get(ws) ?? 0) >= scenario.failTurnsListFrom
      ) {
        return { error: { code: -32_603, message: 'failed to read thread history' } };
      }

      if (scenario.refuseTurnsListOf?.includes(thread.id) === true) {
        return { error: { code: -32_600, message: `no rollout found for thread id ${thread.id}` } };
      }

      const parsed = TURNS_LIST_PARAMS_SCHEMA.parse(params);

      const start =
        parsed.cursor === undefined || parsed.cursor === null ? 0 : Number(parsed.cursor);

      const end = start + (parsed.limit ?? 20);
      const newestFirst = thread.turns.toReversed();

      return {
        result: {
          data: newestFirst.slice(start, end),
          nextCursor: end < newestFirst.length ? String(end) : null,
        },
      };
    }

    if (method === 'turn/start' && scenario.rejectTurnStarts === true) {
      return { error: { code: -32_602, message: 'input rejected' } };
    }

    if (method === 'turn/start' && overloads < (scenario.overloadTurnStarts ?? 0)) {
      overloads += 1;

      // Codex answers with this overload error when its queue is full.
      return { error: { code: -32_001, message: 'Server overloaded; retry later.' } };
    }

    if (method === 'turn/start') {
      turnStartRequests += 1;

      if (turnStartRequests === scenario.dropBeforeTurnStart) {
        ws.close();

        return null;
      }

      turnStarts += 1;

      // The connection drops before the answer and before any notification
      // of the turn reaches it.
      const dropped = turnStarts === scenario.dropOnTurnStart;

      if (dropped) {
        connections.delete(ws);
      }

      const parsed = TURN_START_PARAMS_SCHEMA.parse(params);
      const text = parsed.input.map((part) => part.text).join('\n');
      const turn = startTurn(thread, text, parsed.clientUserMessageId);

      if (dropped) {
        ws.close();

        return null;
      }

      return { result: { turn: { id: turn.id, status: turn.status, items: [] } } };
    }

    return { error: { code: -32_601, message: `unknown method ${method}` } };
  };

  rmSync(socket, { force: true });

  const server = Bun.serve({
    unix: socket,
    fetch: answerUpgrade,
    websocket: {
      open: (ws) => {
        opened += 1;

        connectionNumbers.set(ws, opened);
        connections.add(ws);

        latest = ws;
      },
      close: (ws) => {
        connections.delete(ws);
      },
      message: (ws, data) => {
        const value: unknown = JSON.parse(String(data));
        const response = RESPONSE_SCHEMA.safeParse(value);

        if (response.success && !('method' in response.data)) {
          toolCalls.get(String(response.data.id))?.(response.data.result ?? response.data.error);
          toolCalls.delete(String(response.data.id));

          return;
        }

        const request = REQUEST_SCHEMA.parse(value);
        const recorded = { method: request.method, params: request.params };

        requests.push(recorded);

        onRequest(recorded);

        const answer = answerRequest(ws, request.method, request.params);

        if (answer !== null) {
          sendLine(ws, { id: request.id, ...answer });
        }
      },
    },
  });

  return {
    requests,
    callTool: (tool: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
      const thread = [...threads.values()].at(-1);
      const turn = thread?.turns.at(-1);
      const id = mintID('call');

      if (latest === null || thread === undefined || turn === undefined) {
        throw new Error('the stand-in has no connection with a turn to call a tool in');
      }

      const answered = new Promise<unknown>((resolve) => {
        toolCalls.set(id, resolve);
      });

      sendLine(latest, {
        id,
        method: 'item/tool/call',
        params: {
          threadId: thread.id,
          turnId: turn.id,
          callId: id,
          namespace: 'atc',
          tool,
          arguments: args,
        },
      });

      return answered;
    },
    completeHeldTurns: () => {
      for (const thread of threads.values()) {
        for (const turn of thread.turns.filter((t) => t.status === 'inProgress')) {
          updateTurnCompleted(thread, turn);
        }
      }
    },
    stop: async () => {
      await server.stop(true);

      rmSync(socket, { force: true });
    },
  };
}

// The App Server speaks only over a WebSocket, so a plain request is refused.
function answerUpgrade(request: Request, bunServer: Server<undefined>) {
  return bunServer.upgrade(request) ? undefined : new Response('upgrade required', { status: 426 });
}

function sendLine(ws: ServerWebSocket, value: unknown): void {
  ws.send(JSON.stringify(value));
}
