import type {
  BridgedMessage,
  BridgedNotice,
  MessageBridgeHost,
  MessageBridgeTap,
  UnsettledMessage,
} from '@atc/plugin-api';
import { z } from 'zod';
import type {
  AppServerConnection,
  AppServerNotification,
  AppServerRequest,
} from './app-server-connection';
import { AppServerError } from './app-server-error';
import { buildThreadStartParams } from './build-thread-start-params';
import { NOTE_LABELS } from './note-labels';
import { parseAppServerTurn } from './parse-app-server-turn';
import type { AppServerTurn } from './parse-app-server-turn';
import { planThreadRecovery } from './plan-thread-recovery';
import { planTurnSettlement } from './plan-turn-settlement';
import type { TurnSettlement } from './plan-turn-settlement';
import { renderAtcAnswer } from './render-atc-answer';
import { renderAtcEnvelope } from './render-atc-envelope';

/**
 * What one bridge works with: its atc session, the folder a new thread
 * works in, the daemon's side of the bridge, how it opens a connection to
 * the session's App Server, the thread a restored session resumes, the
 * model the spawn asked for, if any, and the waits between reconnect
 * attempts and between sends the server turns away as overloaded, which
 * double from `first` up to `max`.
 */
export interface AppServerBridgeConfig {
  readonly session: string;
  readonly cwd: string;
  readonly host: MessageBridgeHost;
  readonly openConnection: () => Promise<AppServerConnection>;
  readonly resumeThread: string | null;
  readonly model?: string;
  readonly retryMs?: { readonly first: number; readonly max: number };
}

const THREAD_RESULT_SCHEMA = z.looseObject({ thread: z.looseObject({ id: z.string() }) });
const TURN_RESULT_SCHEMA = z.looseObject({ turn: z.looseObject({ id: z.string() }) });

const TURNS_PAGE_SCHEMA = z.looseObject({
  data: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
});

const NOTIFICATION_SCHEMA = z.looseObject({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  turn: z.unknown().optional(),
  item: z.unknown().optional(),
});

const TOOL_CALL_SCHEMA = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

// A notice goes out as a user message whose client id holds this prefix,
// so no stored turn mistakes it for a message of the session's own.
const NOTICE_PREFIX = 'notice:';

// The JSON-RPC error code a Codex App Server answers with when its queue
// is full: the request was not taken, and the same request may succeed
// later.
const OVERLOADED_CODE = -32_001;

/**
 * The daemon's bridge to one session's Codex App Server thread. It starts
 * or resumes the thread, and once delivery starts it sends each inbox
 * message with `turn/start`, with the message id as the client message id,
 * marks it delivered once the server takes it, and settles it when its
 * turn ends: answered with the turn's last reply, or unanswered. A send the
 * server turns away as overloaded leaves the message or notice queued, and
 * the bridge sends it again after a wait that doubles with each refusal.
 * The thread and each turn run on the model the spawn asked for, so a
 * message that arrives before the terminal applies that model still runs
 * on it. It serves
 * the `atc.note` and `atc.answer` tool calls of its thread and answers no
 * other server request, so approvals stay with the terminal.
 *
 * Each connection recovers before it delivers anything: it reads the
 * thread's stored turns and settles every unsettled message from them,
 * since the server keeps no record of which client message ids it took.
 * A failed read stops the recovery with every message as it was, and the
 * bridge drops the connection and tries again later. Notifications that
 * arrive before a recovery finishes wait and apply after it, and the tap
 * that hands the bridge inbox messages attaches only then.
 */
export class AppServerBridge {
  threadID: string | null;

  private readonly config: AppServerBridgeConfig;

  private conn: AppServerConnection | null = null;

  private ready = false;

  private delivering = false;

  private stopped = false;

  private readonly waitingNotifications: AppServerNotification[] = [];

  // Tool calls a resumed thread replays before recovery restores the turn
  // that carries each message; they are answered once recovery ends.
  private readonly waitingToolCalls: AppServerRequest[] = [];

  // The turn that carries each message the bridge tracks, until it settles.
  private readonly carried = new Map<string, string>();

  // The last reply each tracked turn has given so far.
  private readonly replies = new Map<string, string>();

  private readonly settledTurns = new Set<string>();

  private sending: Promise<void> = Promise.resolve();

  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private retryDelay: number;

  private overloadTimer: ReturnType<typeof setTimeout> | undefined;

  private overloadDelay: number;

  private readonly tap: MessageBridgeTap;

  constructor(config: AppServerBridgeConfig) {
    this.config = config;
    this.threadID = config.resumeThread;
    this.retryDelay = config.retryMs?.first ?? 500;
    this.overloadDelay = config.retryMs?.first ?? 500;

    this.tap = {
      takeMessage: (message) => {
        this.scheduleSend(() => this.sendMessage(message));
      },
      takeNotice: (notice) => {
        this.scheduleSend(() => this.sendNotice(notice));
      },
      close: () => {},
    };
  }

  /**
   * Connects, then starts the session's thread or resumes the one it was
   * given, and resolves with the thread's id. A thread that cannot be
   * resumed is replaced by a new one. Rejects when no App Server answers.
   */
  async open(): Promise<string> {
    try {
      return await this.openThread(true);
    } catch (error) {
      this.detachConnection();
      throw error;
    }
  }

  /**
   * Starts delivery: the first recovery runs, then the tap attaches.
   */
  startDelivery(): void {
    this.delivering = true;
    void this.reconcileMessages();
  }

  /**
   * Moves the bridge to the thread the terminal shows now, as after the
   * terminal starts or resumes another thread. The move waits behind the
   * send in flight, so a message the old thread took is tracked there and
   * never sent again. Then the connection drops, so nothing more goes to
   * the old thread, and the next one resumes the new thread and recovers
   * before it delivers. Each message a turn of the old thread still carries
   * ends unanswered, since no turn of the new thread will carry it. The
   * thread the bridge already serves changes nothing.
   */
  updateThread(thread: string): void {
    this.scheduleSend(() => this.updateThreadNow(thread));
  }

  /**
   * Stops the bridge for good: no reconnect follows, and the tap detaches.
   */
  stop(): void {
    this.stopped = true;

    clearTimeout(this.retryTimer);

    this.detachConnection();
  }

  private async openThread(isFirst: boolean): Promise<string> {
    const conn = await this.config.openConnection();

    // A stop that landed while the connection opened leaves it unused.
    if (this.stopped) {
      conn.dispose();
      throw new AppServerError(-1, 'the bridge stopped');
    }

    this.conn = conn;
    this.ready = false;

    conn.onNotification = (notification) => {
      if (conn === this.conn) {
        this.applyNotification(notification);
      }
    };

    conn.onRequest = (request) => {
      if (conn !== this.conn) {
        return;
      }

      if (!this.ready) {
        this.waitingToolCalls.push(request);

        return;
      }

      void this.answerToolCall(conn, request);
    };

    conn.onClose = () => {
      if (conn === this.conn) {
        this.detachConnection();
        this.scheduleReconnect();
      }
    };

    await conn.sendRequest('initialize', {
      clientInfo: { name: 'atc', title: null, version: '1' },
      capabilities: { experimentalApi: true },
    });

    if (this.threadID !== null) {
      try {
        await conn.sendRequest('thread/resume', {
          threadId: this.threadID,
          excludeTurns: true,
          ...this.buildModelParams(),
        });

        return this.threadID;
      } catch (error) {
        if (!isFirst) {
          throw error;
        }

        this.config.host.log(
          `codex app server: thread ${this.threadID} did not resume (${String(error)}); starting a new one`,
        );
      }
    }

    const params = buildThreadStartParams(this.config.session, this.config.cwd, this.config.model);

    const result = await conn.sendRequest('thread/start', params);

    const started = THREAD_RESULT_SCHEMA.parse(result);
    const threadID = started.thread.id;

    // A new thread has no rollout until its first turn, and a terminal
    // cannot resume a thread without one; one injected developer item
    // writes it with no model turn.
    await conn.sendRequest('thread/inject_items', {
      threadId: threadID,
      items: [
        {
          type: 'message',
          role: 'developer',
          content: [
            { type: 'input_text', text: `atc bridge attached for session ${this.config.session}.` },
          ],
        },
      ],
    });

    this.threadID = threadID;

    return threadID;
  }

  // Settles every unsettled message from the thread's stored turns, applies
  // the notifications that waited, and only then attaches the tap. A failed
  // read changes nothing and tries again on a new connection.
  private async reconcileMessages(): Promise<void> {
    const conn = this.conn;

    if (conn === null || !this.delivering || this.stopped) {
      return;
    }

    let unsettled: readonly UnsettledMessage[];
    let turns: readonly AppServerTurn[];

    try {
      unsettled = await this.config.host.collectUnsettledMessages();

      turns = unsettled.length === 0 ? [] : await this.collectTurns(conn, unsettled);
    } catch (error) {
      this.config.host.log(
        `codex app server: recovery of session ${this.config.session} stopped, every message kept as it was (${String(error)})`,
      );

      if (conn === this.conn) {
        this.detachConnection();
        this.scheduleReconnect();
      }

      return;
    }

    if (conn !== this.conn) {
      return;
    }

    const recovery = planThreadRecovery(unsettled, turns);

    for (const id of recovery.acks) {
      await this.config.host.ackMessage(id);
    }

    for (const settlement of recovery.settlements) {
      this.settledTurns.add(settlement.turn);

      await this.applySettlement(settlement);
    }

    if (recovery.lost.length > 0) {
      await this.config.host.applyNote({
        kind: 'unanswered',
        messages: recovery.lost,
        reason: 'not_started',
      });
    }

    for (const [message, turn] of recovery.carried) {
      this.carried.set(message, turn);
    }

    for (const [turn, reply] of recovery.replies) {
      this.replies.set(turn, reply);
    }

    if (conn !== this.conn) {
      return;
    }

    this.ready = true;
    this.retryDelay = this.config.retryMs?.first ?? 500;

    for (const notification of this.waitingNotifications.splice(0)) {
      this.applyNotification(notification);
    }

    for (const request of this.waitingToolCalls.splice(0)) {
      void this.answerToolCall(conn, request);
    }

    if (!this.config.host.attachTap(this.tap)) {
      this.config.host.log(`codex app server: session ${this.config.session} refused the tap`);
    }
  }

  // Pages back through the thread's turns until every unsettled message
  // has its turn or the history ends. A failed page rejects the whole read.
  /* oxlint-disable prefer-readonly-parameter-types -- the read goes over the live connection */
  private async collectTurns(
    conn: AppServerConnection,
    unsettled: readonly UnsettledMessage[],
  ): Promise<AppServerTurn[]> {
    const open = new Set(unsettled.map((m) => m.id));

    const turns: AppServerTurn[] = [];
    let cursor: string | null = null;

    do {
      const result = await conn.sendRequest('thread/turns/list', {
        threadId: this.threadID,
        limit: 20,
        itemsView: 'full',
        cursor,
      });

      const page = TURNS_PAGE_SCHEMA.parse(result);

      for (const raw of page.data) {
        const turn = parseAppServerTurn(raw);

        if (turn !== null) {
          turns.push(turn);

          for (const item of turn.items) {
            open.delete(item.clientId ?? '');
          }
        }
      }

      cursor = page.nextCursor ?? null;
    } while (cursor !== null && open.size > 0);

    return turns;
  }

  /* oxlint-enable prefer-readonly-parameter-types */

  private applyNotification(notification: AppServerNotification): void {
    if (!this.ready) {
      this.waitingNotifications.push(notification);

      return;
    }

    const params = NOTIFICATION_SCHEMA.safeParse(notification.params);

    // The server also sends notifications of threads the bridge never
    // joined, such as the one Codex starts to name a session.
    if (!params.success || params.data.threadId !== this.threadID) {
      return;
    }

    if (notification.method === 'item/completed' && params.data.turnId !== undefined) {
      const item = parseAppServerTurn({ id: '', status: '', items: [params.data.item] })?.items[0];

      if (item?.type === 'agentMessage' && item.text !== undefined) {
        this.replies.set(params.data.turnId, item.text);
      }

      if (
        item?.type === 'userMessage' &&
        item.clientId !== undefined &&
        !item.clientId.startsWith(NOTICE_PREFIX) &&
        !this.settledTurns.has(params.data.turnId)
      ) {
        this.carried.set(item.clientId, params.data.turnId);
      }

      return;
    }

    if (notification.method === 'turn/completed') {
      const turn = parseAppServerTurn(params.data.turn);

      if (turn !== null) {
        void this.applyTurnCompleted(turn);
      }
    }
  }

  private async applyTurnCompleted(turn: AppServerTurn): Promise<void> {
    if (this.settledTurns.has(turn.id)) {
      return;
    }

    this.settledTurns.add(turn.id);

    const messages = [...this.carried].filter(([, t]) => t === turn.id).map(([m]) => m);

    const reply =
      this.replies.get(turn.id) ?? turn.items.findLast((i) => i.type === 'agentMessage')?.text;

    for (const message of messages) {
      this.carried.delete(message);
    }

    this.replies.delete(turn.id);

    const settlement = planTurnSettlement(turn.id, turn.status, messages, reply);

    if (settlement !== null) {
      await this.applySettlement(settlement);
    }
  }

  private async applySettlement(settlement: TurnSettlement): Promise<void> {
    const payload =
      settlement.kind === 'answered'
        ? {
            kind: 'answered',
            messages: settlement.messages,
            answer: settlement.answer,
            turn: settlement.turn,
          }
        : {
            kind: 'unanswered',
            messages: settlement.messages,
            reason: settlement.reason,
            turn: settlement.turn,
          };

    await this.config.host.applyNote(payload);
  }

  private async updateThreadNow(thread: string): Promise<void> {
    if (this.stopped || thread === this.threadID) {
      return;
    }

    this.config.host.log(
      `codex app server: session ${this.config.session} moved from thread ${this.threadID ?? 'none'} to ${thread}`,
    );

    this.threadID = thread;

    // Only the messages end here. Their turn may still run, and when the
    // terminal comes back to it, a later message joins it and settles
    // with it.
    const stranded = [...this.carried.keys()];

    this.carried.clear();
    this.replies.clear();

    const moving = this.conn !== null;

    if (moving) {
      this.detachConnection();
    }

    // The next recovery starts only after this note, so it never reads one
    // of these messages as unsettled.
    try {
      if (stranded.length > 0) {
        await this.config.host.applyNote({
          kind: 'unanswered',
          messages: stranded,
          reason: 'thread_switched',
        });
      }
    } finally {
      if (moving) {
        this.retryDelay = this.config.retryMs?.first ?? 500;

        this.scheduleReconnect();
      }
    }
  }

  // Sends go out one at a time, in the order the tap handed them over.
  private scheduleSend(send: () => Promise<void>): void {
    const previous = this.sending;

    this.sending = (async () => {
      await previous;

      try {
        await send();
      } catch (error) {
        this.config.host.log(`codex app server: a send failed (${String(error)})`);
      }
    })();
  }

  // A message that fails to send stays queued: the connection drops, and
  // the next one recovers before the tap hands the message over again.
  private async sendMessage(message: BridgedMessage): Promise<void> {
    const conn = this.conn;

    if (conn === null || !this.ready) {
      return;
    }

    let turnID: string;

    try {
      const result = await conn.sendRequest('turn/start', {
        threadId: this.threadID,
        input: [{ type: 'text', text: renderAtcEnvelope(message), text_elements: [] }],
        clientUserMessageId: message.id,
        ...this.buildModelParams(),
      });

      const started = TURN_RESULT_SCHEMA.parse(result);

      turnID = started.turn.id;
    } catch (error) {
      if (isOverload(error)) {
        this.config.host.log(
          `codex app server: the App Server is overloaded; message ${message.id} stayed queued (${error.message})`,
        );

        this.scheduleOverloadRetry(conn, () => this.sendMessage(message));

        return;
      }

      // An error the server answered shows it refused the message, and a
      // resend would meet the same refusal, so the message ends unanswered.
      if (isRefusal(error)) {
        this.config.host.log(
          `codex app server: the App Server refused message ${message.id} (${error.message})`,
        );

        await this.config.host.applyNote({
          kind: 'unanswered',
          messages: [message.id],
          reason: 'error',
        });

        return;
      }

      this.config.host.log(
        `codex app server: message ${message.id} stayed queued (${String(error)})`,
      );

      if (conn === this.conn) {
        this.detachConnection();
        this.scheduleReconnect();
      }

      return;
    }

    this.overloadDelay = this.config.retryMs?.first ?? 500;

    if (!this.settledTurns.has(turnID)) {
      this.carried.set(message.id, turnID);
    }

    await this.config.host.ackMessage(message.id);
  }

  private async sendNotice(notice: BridgedNotice): Promise<void> {
    const conn = this.conn;

    if (conn === null || !this.ready) {
      return;
    }

    try {
      await conn.sendRequest('turn/start', {
        threadId: this.threadID,
        input: [{ type: 'text', text: renderAtcAnswer(notice), text_elements: [] }],
        clientUserMessageId: `${NOTICE_PREFIX}${notice.id}`,
        ...this.buildModelParams(),
      });
    } catch (error) {
      if (isOverload(error)) {
        this.config.host.log(
          `codex app server: the App Server is overloaded; notice ${notice.id} stayed queued (${error.message})`,
        );

        this.scheduleOverloadRetry(conn, () => this.sendNotice(notice));

        return;
      }

      // A notice the server refused is taken all the same, so it holds up
      // no later item of the inbox.
      if (isRefusal(error)) {
        this.config.host.log(
          `codex app server: the App Server refused notice ${notice.id} (${error.message})`,
        );

        await this.config.host.ackNotice(notice.id);

        return;
      }

      this.config.host.log(
        `codex app server: notice ${notice.id} stayed queued (${String(error)})`,
      );

      if (conn === this.conn) {
        this.detachConnection();
        this.scheduleReconnect();
      }

      return;
    }

    this.overloadDelay = this.config.retryMs?.first ?? 500;

    await this.config.host.ackNotice(notice.id);
  }

  // The model field of a thread or turn request: the model the spawn asked
  // for, or nothing, which leaves the model to the server.
  private buildModelParams(): { model?: string } {
    return this.config.model === undefined ? {} : { model: this.config.model };
  }

  // Sends the item again once the wait ends. The daemon hands the next item
  // only after this one is acked or settled, so the order holds. A
  // connection that drops first cancels the retry, and its successor's tap
  // hands the item over again.
  // oxlint-disable-next-line prefer-readonly-parameter-types -- the retry belongs to the live connection
  private scheduleOverloadRetry(conn: AppServerConnection, send: () => Promise<void>): void {
    const delay = this.overloadDelay;

    this.overloadDelay = Math.min(delay * 2, this.config.retryMs?.max ?? 30_000);

    this.overloadTimer = setTimeout(() => {
      this.overloadTimer = undefined;

      if (conn === this.conn) {
        this.scheduleSend(send);
      }
    }, delay);
  }

  // Serves a call to one of the bridge's own tools on its thread; every
  // other server request, approvals among them, is left to the terminal.
  /* oxlint-disable prefer-readonly-parameter-types -- the answer goes over the live connection */
  private async answerToolCall(
    conn: AppServerConnection,
    request: AppServerRequest,
  ): Promise<void> {
    if (request.method !== 'item/tool/call') {
      return;
    }

    const call = TOOL_CALL_SCHEMA.safeParse(request.params);

    if (!call.success || call.data.threadId !== this.threadID) {
      return;
    }

    const args = call.data.arguments ?? {};
    const text = typeof args['text'] === 'string' ? args['text'].trim() : '';

    const sendRefusal = (reason: string) => {
      conn.sendResult(request.id, {
        success: false,
        contentItems: [{ type: 'inputText', text: reason }],
      });
    };

    if (text === '') {
      sendRefusal(`${call.data.tool} needs non-empty text`);

      return;
    }

    if (call.data.tool === 'note') {
      const label = typeof args['label'] === 'string' ? args['label'] : 'progress';

      if (!NOTE_LABELS.some((l) => l === label)) {
        sendRefusal(`note label must be ${NOTE_LABELS.join(', ')}`);

        return;
      }

      await this.config.host.applyNote({ kind: 'note', label, text });

      conn.sendResult(request.id, {
        success: true,
        contentItems: [{ type: 'inputText', text: 'Handed to atc for its event feed.' }],
      });

      return;
    }

    if (call.data.tool !== 'answer') {
      return;
    }

    const message = typeof args['message'] === 'string' ? args['message'] : '';

    if (this.carried.get(message) !== call.data.turnId) {
      sendRefusal(`the running turn carries no message ${message}`);

      return;
    }

    this.carried.delete(message);

    await this.config.host.applyNote({
      kind: 'answered',
      message,
      answer: text,
      turn: call.data.turnId,
    });

    conn.sendResult(request.id, {
      success: true,
      contentItems: [{ type: 'inputText', text: `Handed to atc as the answer to ${message}.` }],
    });
  }

  /* oxlint-enable prefer-readonly-parameter-types */

  // Closes the connection and detaches the tap, so nothing is delivered
  // until a new connection recovers.
  private detachConnection(): void {
    const conn = this.conn;

    this.conn = null;
    this.ready = false;

    clearTimeout(this.overloadTimer);

    this.overloadTimer = undefined;

    // The next connection's recovery reads the stored turns, which hold
    // everything these held, and a stale reply here would outrank them.
    this.waitingNotifications.length = 0;

    // A tool call waits on the connection that carried it, and that
    // connection is gone.
    this.waitingToolCalls.length = 0;

    this.config.host.detachTap(this.tap);
    conn?.dispose();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer !== undefined) {
      return;
    }

    const delay = this.retryDelay;

    this.retryDelay = Math.min(delay * 2, this.config.retryMs?.max ?? 30_000);

    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.restartConnection();
    }, delay);
  }

  private async restartConnection(): Promise<void> {
    if (this.stopped) {
      return;
    }

    try {
      await this.openThread(false);
    } catch (error) {
      this.config.host.log(`codex app server: reconnect failed (${String(error)})`);
      this.detachConnection();
      this.scheduleReconnect();

      return;
    }

    await this.reconcileMessages();
  }
}

// Whether a request failed because the server answered it with an error,
// as opposed to a connection that closed before an answer came.
function isRefusal(error: unknown): error is AppServerError {
  return error instanceof AppServerError && error.code !== -1;
}

// Whether the server turned a request away because its queue was full.
function isOverload(error: unknown): error is AppServerError {
  return error instanceof AppServerError && error.code === OVERLOADED_CODE;
}
