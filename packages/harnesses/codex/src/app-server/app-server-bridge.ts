import type {
  BridgedMessage,
  BridgedNotice,
  MessageBridgeHost,
  MessageBridgeTap,
  UnsettledMessage,
} from '@atc/plugin-api';
import { z } from 'zod';
import { answerToolCall } from './answer-tool-call';
import type {
  AppServerConnection,
  AppServerNotification,
  AppServerRequest,
} from './app-server-connection';
import { AppServerError } from './app-server-error';
import { applyLeftThreadRecovery } from './apply-left-thread-recovery';
import { applyThreadRecovery } from './apply-thread-recovery';
import { applyTurnCompleted } from './apply-turn-completed';
import { buildModelParams } from './build-model-params';
import { buildThreadStartParams } from './build-thread-start-params';
import { NOTICE_PREFIX } from './notice-prefix';
import { parseAppServerTurn } from './parse-app-server-turn';
import type { AppServerTurn } from './parse-app-server-turn';
import type { LeftThreadRecovery } from './plan-left-thread-recovery';
import { planThreadRecovery } from './plan-thread-recovery';
import { readLeftThreads } from './read-left-threads';
import { readThreadTurns } from './read-thread-turns';
import { sendBridgedMessage } from './send-bridged-message';
import { sendBridgedNotice } from './send-bridged-notice';
import type { TurnSendContext } from './turn-send-context';
import { UnconfirmedSends } from './unconfirmed-sends';

export interface AppServerBridgeConfig {
  readonly session: string;
  readonly cwd: string;
  readonly host: MessageBridgeHost;
  readonly openConnection: () => Promise<AppServerConnection>;
  readonly resumeThread: string | null;
  readonly model?: string;

  // the file that keeps the thread of each unconfirmed send across a daemon restart; without it
  // the threads live in memory alone
  readonly unconfirmedFile?: string;

  // the waits between reconnects and between overloaded sends, doubling from `first` up to `max`
  readonly retryMs?: { readonly first: number; readonly max: number };
}

const THREAD_RESULT_SCHEMA = z.looseObject({ thread: z.looseObject({ id: z.string() }) });

const NOTIFICATION_SCHEMA = z.looseObject({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  turn: z.unknown().optional(),
  item: z.unknown().optional(),
});

// each connection settles every unsettled message from the thread's stored turns before it
// delivers, since the server keeps no record of which client message ids it took
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

  // The thread each message went to when its connection dropped before the
  // answer to its send, until a recovery reads that thread. The server may
  // have taken the message, and only that thread's turns show whether it did.
  private readonly unconfirmed: UnconfirmedSends;

  private sending: Promise<void> = Promise.resolve();

  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private retryDelay: number;

  // Ends the overload wait in progress early, so its send gives up.
  private endOverloadWait: (() => void) | undefined;

  // The thread of the last move that waits in the send queue. While it
  // waits, no send goes out, so nothing more reaches the thread it leaves.
  private pendingThread: string | null = null;

  private overloadDelay: number;

  private readonly tap: MessageBridgeTap;

  private readonly sendContext: TurnSendContext;

  constructor(config: AppServerBridgeConfig) {
    this.config = config;
    this.threadID = config.resumeThread;
    this.retryDelay = config.retryMs?.first ?? 500;
    this.overloadDelay = config.retryMs?.first ?? 500;

    this.unconfirmed = new UnconfirmedSends(config.unconfirmedFile ?? null, (line) => {
      config.host.log(line);
    });

    this.tap = {
      takeMessage: (message) => {
        this.scheduleSend(() => this.sendMessage(message));
      },
      takeNotice: (notice) => {
        this.scheduleSend(() => this.sendNotice(notice));
      },
      close: () => {},
    };

    this.sendContext = {
      host: config.host,
      model: config.model,
      unconfirmed: this.unconfirmed,
      waitOutOverload: (conn) => this.waitOutOverload(conn),
      dropConnection: (conn) => {
        if (conn === this.conn) {
          this.detachConnection();
          this.scheduleReconnect();
        }
      },
      resetOverload: () => {
        this.overloadDelay = this.config.retryMs?.first ?? 500;
      },
      carryMessage: (message, turn) => {
        if (!this.settledTurns.has(turn)) {
          this.carried.set(message, turn);
        }
      },
    };
  }

  // a thread that cannot be resumed is replaced by a new one
  async open(): Promise<string> {
    try {
      return await this.openThread(true);
    } catch (error) {
      this.detachConnection();
      throw error;
    }
  }

  startDelivery(): void {
    this.delivering = true;
    void this.reconcileMessages();
  }

  // the move waits behind the send in flight, so a message the old thread took is tracked there
  // and never sent again; then the connection drops and the next one resumes the new thread
  updateThread(thread: string): void {
    // A send that waits out an overload holds the queue, so the move ends
    // the wait rather than wait behind it. A send whose overload answer
    // comes later finds the move pending and does not wait.
    if (thread !== (this.pendingThread ?? this.threadID)) {
      this.pendingThread = thread;
      this.endOverloadWait?.();
    }

    this.scheduleSend(() => this.updateThreadNow(thread));
  }

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

      void answerToolCall({
        conn,
        request,
        threadID: this.threadID,
        carried: this.carried,
        host: this.config.host,
      });
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
          ...buildModelParams(this.config.model),
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

    const unconfirmed = this.unconfirmed.collectMessages();
    let unsettled: readonly UnsettledMessage[];
    let left: LeftThreadRecovery[];
    let turns: readonly AppServerTurn[];

    try {
      const all = await this.config.host.readUnsettledMessages();

      left = await readLeftThreads({
        conn,
        unsettled: all,
        unconfirmed: this.unconfirmed,
        host: this.config.host,
        isLeft: (message) => this.isLeft(message),
      });

      // A message a left thread holds belongs to that thread alone, so the
      // thread the bridge serves never sends it again.
      unsettled = [...left.flatMap((l) => l.kept), ...all.filter((m) => !this.isLeft(m.id))];
      turns = unsettled.length === 0 ? [] : await readThreadTurns(conn, this.threadID, unsettled);
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

    for (const recovery of left) {
      await applyLeftThreadRecovery(this.config.host, recovery);
    }

    this.unconfirmed.removeMessages(unconfirmed);

    await applyThreadRecovery({
      recovery: planThreadRecovery(unsettled, turns),
      carried: this.carried,
      replies: this.replies,
      settledTurns: this.settledTurns,
      host: this.config.host,
    });

    if (conn !== this.conn) {
      return;
    }

    this.ready = true;
    this.retryDelay = this.config.retryMs?.first ?? 500;

    for (const notification of this.waitingNotifications.splice(0)) {
      this.applyNotification(notification);
    }

    for (const request of this.waitingToolCalls.splice(0)) {
      void answerToolCall({
        conn,
        request,
        threadID: this.threadID,
        carried: this.carried,
        host: this.config.host,
      });
    }

    if (!this.config.host.attachTap(this.tap)) {
      this.config.host.log(`codex app server: session ${this.config.session} refused the tap`);
    }
  }

  // Whether the message went unconfirmed to a thread other than the one the
  // bridge serves.
  private isLeft(message: string): boolean {
    const thread = this.unconfirmed.findThread(message);

    return thread !== undefined && thread !== this.threadID;
  }

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
        void applyTurnCompleted({
          turn,
          carried: this.carried,
          replies: this.replies,
          settledTurns: this.settledTurns,
          host: this.config.host,
        });
      }
    }
  }

  private async updateThreadNow(thread: string): Promise<void> {
    if (thread === this.pendingThread) {
      this.pendingThread = null;
    }

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

  // Sends a message once the bridge is ready on a thread it is not leaving.
  private async sendMessage(message: BridgedMessage): Promise<void> {
    const conn = this.conn;
    const thread = this.threadID;

    if (conn === null || thread === null || !this.ready || this.pendingThread !== null) {
      return;
    }

    await sendBridgedMessage(this.sendContext, {
      conn,
      thread,
      message,
      resend: () => this.sendMessage(message),
    });
  }

  private async sendNotice(notice: BridgedNotice): Promise<void> {
    const conn = this.conn;

    if (conn === null || !this.ready || this.pendingThread !== null) {
      return;
    }

    await sendBridgedNotice(this.sendContext, {
      conn,
      thread: this.threadID,
      notice,
      resend: () => this.sendNotice(notice),
    });
  }

  // waits inside the send in flight so later items queue behind it and the order holds; true
  // means send again on the same connection, and a drop, stop or thread move ends it with false
  private async waitOutOverload(conn: AppServerConnection): Promise<boolean> {
    if (this.pendingThread !== null) {
      return false;
    }

    const delay = this.overloadDelay;

    this.overloadDelay = Math.min(delay * 2, this.config.retryMs?.max ?? 30_000);

    const wait = Promise.withResolvers<boolean>();

    const timer = setTimeout(() => {
      wait.resolve(false);
    }, delay);

    this.endOverloadWait = () => {
      clearTimeout(timer);

      wait.resolve(true);
    };

    const ended = await wait.promise;

    this.endOverloadWait = undefined;

    return !ended && conn === this.conn && !this.stopped;
  }

  // Closes the connection and detaches the tap, so nothing is delivered
  // until a new connection recovers.
  private detachConnection(): void {
    const conn = this.conn;

    this.conn = null;
    this.ready = false;
    this.endOverloadWait?.();

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
