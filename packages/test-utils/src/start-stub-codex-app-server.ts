import { rmSync } from 'node:fs';
import type { ServerWebSocket } from 'bun';
import { z } from 'zod';

/**
 * How the stand-in behaves. `reply` is the text of the final reply the
 * stand-in model gives each turn. `holdTurns` leaves each turn in progress
 * until a later step completes it. `dropOnTurnStart` takes the
 * `turn/start` of that number, counted from one, and closes the connection
 * in place of its answer, so the client never learns the server took the
 * message. `completeHeldTurnsOnResume` completes every held turn on a
 * `thread/resume`, with its notifications sent before the answer, as a turn
 * that ends while a client reconnects does. `failTurnsListFrom` answers
 * every `thread/turns/list` with an error on the connection of that number,
 * counted from one, and on every later one. `rejectTurnStarts` answers
 * every `turn/start` with an error and takes no message.
 * `overloadTurnStarts` answers that many of the first `turn/start`
 * requests with the overload error -32_001 and takes nothing from them, as
 * Codex does when its queue is full.
 */
export const STUB_CODEX_APP_SERVER_SCENARIO_SCHEMA = z.object({
  reply: z.string().optional(),
  holdTurns: z.boolean().optional(),
  dropOnTurnStart: z.number().optional(),
  completeHeldTurnsOnResume: z.boolean().optional(),
  failTurnsListFrom: z.number().optional(),
  rejectTurnStarts: z.boolean().optional(),
  overloadTurnStarts: z.number().optional(),
});

export type StubCodexAppServerScenario = Readonly<
  z.output<typeof STUB_CODEX_APP_SERVER_SCENARIO_SCHEMA>
>;

/**
 * One request a client sent the stand-in, as it arrived.
 */
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

/**
 * Starts a stand-in Codex App Server on a Unix socket, speaking the v2
 * JSON-RPC over WebSocket that `codex app-server --listen unix://<path>`
 * speaks, for the methods a bridge sends: `initialize`, `thread/start`,
 * `thread/resume`, `thread/inject_items`, `thread/turns/list` and
 * `turn/start`. A `turn/start` on a thread with a turn in progress joins
 * that turn and returns its id, as Codex does. Each turn's items are the
 * user message, with the `clientUserMessageId` as its `clientId`, and one
 * final answer, each announced with `item/started` and `item/completed`,
 * then `turn/completed`. Threads and turns outlive a connection, so a
 * reconnect finds them. A request for an unknown thread fails with code
 * -32_600, as Codex fails it. `requests` holds every request in order, and
 * `onRequest` sees each one as it arrives. `callTool` sends the latest
 * connection a dynamic tool call and resolves with the client's result.
 * `completeHeldTurns` completes every turn still in progress, as a model
 * that finishes its work does.
 */
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

      return { error: { code: -32_001, message: 'Server overloaded; retry later.' } };
    }

    if (method === 'turn/start') {
      const parsed = TURN_START_PARAMS_SCHEMA.parse(params);
      const text = parsed.input.map((part) => part.text).join('\n');
      const turn = startTurn(thread, text, parsed.clientUserMessageId);

      turnStarts += 1;

      if (turnStarts === scenario.dropOnTurnStart) {
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
    fetch: (req, srv) =>
      srv.upgrade(req) ? undefined : new Response('upgrade required', { status: 426 }),
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

function sendLine(ws: ServerWebSocket, value: unknown): void {
  ws.send(JSON.stringify(value));
}
