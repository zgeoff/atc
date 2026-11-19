import type {
  BridgedMessage,
  BridgedNotice,
  MessageBridgeHost,
  MessageBridgeTap,
  UnsettledMessage,
} from '@atc/plugin-api';
import { z } from 'zod';
import { answerToolCall } from './answer-tool-call';
import { AppServerError } from './app-server-error';
import { applyLeftThreadRecovery } from './apply-left-thread-recovery';
import { applyThreadRecovery } from './apply-thread-recovery';
import { applyTurnCompleted } from './apply-turn-completed';
import { buildModelParams } from './build-model-params';
import { buildThreadStartParams } from './build-thread-start-params';
import type {
  AppServerConnection,
  AppServerNotification,
  AppServerRequest,
} from './create-app-server-connection';
import { createUnconfirmedSends } from './create-unconfirmed-sends';
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

export interface AppServerBridgeConfig {
  readonly session: string;
  readonly cwd: string;
  readonly host: MessageBridgeHost;
  readonly openConnection: () => Promise<AppServerConnection>;
  readonly resumeThread: string | null;
  readonly model?: string;

  readonly unconfirmedFile?: string;

  readonly retryMs?: { readonly first: number; readonly max: number };
}

export interface AppServerBridge {
  threadID: string | null;

  readonly open: () => Promise<string>;
  readonly startDelivery: () => void;

  readonly updateThread: (thread: string) => void;
  readonly stop: () => void;
}

const THREAD_RESULT_SCHEMA = z.looseObject({ thread: z.looseObject({ id: z.string() }) });

const NOTIFICATION_SCHEMA = z.looseObject({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  turn: z.unknown().optional(),
  item: z.unknown().optional(),
});

// The server keeps no record of which client message ids it took, so settle unsettled
// messages from the thread's stored turns on each connection.
export function createAppServerBridge(config: AppServerBridgeConfig): AppServerBridge {
  let conn: AppServerConnection | null = null;
  let ready = false;
  let delivering = false;
  let stopped = false;
  const waitingNotifications: AppServerNotification[] = [];
  const waitingToolCalls: AppServerRequest[] = [];

  const carried = new Map<string, string>();
  const replies = new Map<string, string>();
  const settledTurns = new Set<string>();

  let sending: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let endOverloadWait: (() => void) | undefined;
  let pendingThread: string | null = null;
  let threadID = config.resumeThread;
  let retryDelay = config.retryMs?.first ?? 500;
  let overloadDelay = config.retryMs?.first ?? 500;

  const unconfirmed = createUnconfirmedSends(config.unconfirmedFile ?? null, (line) => {
    config.host.log(line);
  });

  const tap: MessageBridgeTap = {
    takeMessage: (message) => {
      scheduleSend(() => sendMessage(message));
    },
    takeNotice: (notice) => {
      scheduleSend(() => sendNotice(notice));
    },
    close: () => {},
  };

  const sendContext: TurnSendContext = {
    host: config.host,
    model: config.model,
    unconfirmed,
    waitOutOverload: (overloaded) => waitOutOverload(overloaded),
    dropConnection: (dropped) => {
      if (dropped === conn) {
        detachConnection();
        scheduleReconnect();
      }
    },
    resetOverload: () => {
      overloadDelay = config.retryMs?.first ?? 500;
    },
    carryMessage: (message, turn) => {
      if (!settledTurns.has(turn)) {
        carried.set(message, turn);
      }
    },
  };

  const openThread = async (isFirst: boolean): Promise<string> => {
    const opened = await config.openConnection();

    if (stopped) {
      opened.dispose();
      throw new AppServerError(-1, 'the bridge stopped');
    }

    conn = opened;
    ready = false;

    opened.onNotification = (notification) => {
      if (opened === conn) {
        applyNotification(notification);
      }
    };

    opened.onRequest = (request) => {
      if (opened !== conn) {
        return;
      }

      if (!ready) {
        waitingToolCalls.push(request);

        return;
      }

      void answerToolCall({
        conn: opened,
        request,
        threadID,
        carried,
        host: config.host,
      });
    };

    opened.onClose = () => {
      if (opened === conn) {
        detachConnection();
        scheduleReconnect();
      }
    };

    await opened.sendRequest('initialize', {
      clientInfo: { name: 'atc', title: null, version: '1' },
      capabilities: { experimentalApi: true },
    });

    if (threadID !== null) {
      try {
        await opened.sendRequest('thread/resume', {
          threadId: threadID,
          excludeTurns: true,
          ...buildModelParams(config.model),
        });

        return threadID;
      } catch (error) {
        if (!isFirst) {
          throw error;
        }

        config.host.log(
          `codex app server: thread ${threadID} did not resume (${String(error)}); starting a new one`,
        );
      }
    }

    const params = buildThreadStartParams(config.session, config.cwd, config.model);

    const result = await opened.sendRequest('thread/start', params);

    const started = THREAD_RESULT_SCHEMA.parse(result);
    const startedID = started.thread.id;

    // A new thread has no rollout until its first turn, and a terminal
    // cannot resume a thread without one; one injected developer item
    // writes it with no model turn.
    await opened.sendRequest('thread/inject_items', {
      threadId: startedID,
      items: [
        {
          type: 'message',
          role: 'developer',
          content: [
            { type: 'input_text', text: `atc bridge attached for session ${config.session}.` },
          ],
        },
      ],
    });

    threadID = startedID;

    return startedID;
  };

  const reconcileMessages = async (): Promise<void> => {
    const current = conn;

    if (current === null || !delivering || stopped) {
      return;
    }

    const unconfirmedMessages = unconfirmed.collectMessages();
    let unsettled: readonly UnsettledMessage[];
    let left: LeftThreadRecovery[];
    let turns: readonly AppServerTurn[];

    try {
      const all = await config.host.readUnsettledMessages();

      left = await readLeftThreads({
        conn: current,
        unsettled: all,
        unconfirmed,
        host: config.host,
        isLeft: (message) => isLeft(message),
      });

      unsettled = [
        ...left.flatMap((recovery) => recovery.kept),
        ...all.filter((message) => !isLeft(message.id)),
      ];

      turns = unsettled.length === 0 ? [] : await readThreadTurns(current, threadID, unsettled);
    } catch (error) {
      config.host.log(
        `codex app server: recovery of session ${config.session} stopped, every message kept as it was (${String(error)})`,
      );

      if (current === conn) {
        detachConnection();
        scheduleReconnect();
      }

      return;
    }

    if (current !== conn) {
      return;
    }

    for (const recovery of left) {
      await applyLeftThreadRecovery(config.host, recovery);
    }

    unconfirmed.removeMessages(unconfirmedMessages);

    await applyThreadRecovery({
      recovery: planThreadRecovery(unsettled, turns),
      carried,
      replies,
      settledTurns,
      host: config.host,
    });

    if (current !== conn) {
      return;
    }

    ready = true;
    retryDelay = config.retryMs?.first ?? 500;

    for (const notification of waitingNotifications.splice(0)) {
      applyNotification(notification);
    }

    for (const request of waitingToolCalls.splice(0)) {
      void answerToolCall({
        conn: current,
        request,
        threadID,
        carried,
        host: config.host,
      });
    }

    if (!config.host.attachTap(tap)) {
      config.host.log(`codex app server: session ${config.session} refused the tap`);
    }
  };

  const isLeft = (message: string): boolean => {
    const thread = unconfirmed.findThread(message);

    return thread !== undefined && thread !== threadID;
  };

  const applyNotification = (notification: AppServerNotification): void => {
    if (!ready) {
      waitingNotifications.push(notification);

      return;
    }

    const params = NOTIFICATION_SCHEMA.safeParse(notification.params);

    // The server also sends notifications of threads the bridge never
    // joined, such as the one Codex starts to name a session.
    if (!params.success || params.data.threadId !== threadID) {
      return;
    }

    if (notification.method === 'item/completed' && params.data.turnId !== undefined) {
      const item = parseAppServerTurn({ id: '', status: '', items: [params.data.item] })?.items[0];

      if (item?.type === 'agentMessage' && item.text !== undefined) {
        replies.set(params.data.turnId, item.text);
      }

      if (
        item?.type === 'userMessage' &&
        item.clientId !== undefined &&
        !item.clientId.startsWith(NOTICE_PREFIX) &&
        !settledTurns.has(params.data.turnId)
      ) {
        carried.set(item.clientId, params.data.turnId);
      }

      return;
    }

    if (notification.method === 'turn/completed') {
      const turn = parseAppServerTurn(params.data.turn);

      if (turn !== null) {
        void applyTurnCompleted({
          turn,
          carried,
          replies,
          settledTurns,
          host: config.host,
        });
      }
    }
  };

  const updateThreadNow = async (thread: string): Promise<void> => {
    if (thread === pendingThread) {
      pendingThread = null;
    }

    if (stopped || thread === threadID) {
      return;
    }

    config.host.log(
      `codex app server: session ${config.session} moved from thread ${threadID ?? 'none'} to ${thread}`,
    );

    threadID = thread;

    const stranded = [...carried.keys()];

    carried.clear();
    replies.clear();

    const moving = conn !== null;

    if (moving) {
      detachConnection();
    }

    try {
      if (stranded.length > 0) {
        await config.host.applyNote({
          kind: 'unanswered',
          messages: stranded,
          reason: 'thread_switched',
        });
      }
    } finally {
      if (moving) {
        retryDelay = config.retryMs?.first ?? 500;

        scheduleReconnect();
      }
    }
  };

  const scheduleSend = (send: () => Promise<void>): void => {
    const previous = sending;

    sending = (async () => {
      await previous;

      try {
        await send();
      } catch (error) {
        config.host.log(`codex app server: a send failed (${String(error)})`);
      }
    })();
  };

  const sendMessage = async (message: BridgedMessage): Promise<void> => {
    const current = conn;
    const thread = threadID;

    if (current === null || thread === null || !ready || pendingThread !== null) {
      return;
    }

    await sendBridgedMessage(sendContext, {
      conn: current,
      thread,
      message,
      resend: () => sendMessage(message),
    });
  };

  const sendNotice = async (notice: BridgedNotice): Promise<void> => {
    const current = conn;

    if (current === null || !ready || pendingThread !== null) {
      return;
    }

    await sendBridgedNotice(sendContext, {
      conn: current,
      thread: threadID,
      notice,
      resend: () => sendNotice(notice),
    });
  };

  const waitOutOverload = async (overloaded: AppServerConnection): Promise<boolean> => {
    if (pendingThread !== null) {
      return false;
    }

    const delay = overloadDelay;

    overloadDelay = Math.min(delay * 2, config.retryMs?.max ?? 30_000);

    const wait = Promise.withResolvers<boolean>();

    const timer = setTimeout(() => {
      wait.resolve(false);
    }, delay);

    endOverloadWait = () => {
      clearTimeout(timer);

      wait.resolve(true);
    };

    const ended = await wait.promise;

    endOverloadWait = undefined;

    return !ended && overloaded === conn && !stopped;
  };

  const detachConnection = (): void => {
    const detached = conn;

    conn = null;
    ready = false;
    endOverloadWait?.();
    waitingNotifications.length = 0;
    waitingToolCalls.length = 0;

    config.host.detachTap(tap);
    detached?.dispose();
  };

  const scheduleReconnect = (): void => {
    if (stopped || retryTimer !== undefined) {
      return;
    }

    const delay = retryDelay;

    retryDelay = Math.min(delay * 2, config.retryMs?.max ?? 30_000);

    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void restartConnection();
    }, delay);
  };

  const restartConnection = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    try {
      await openThread(false);
    } catch (error) {
      config.host.log(`codex app server: reconnect failed (${String(error)})`);

      detachConnection();
      scheduleReconnect();

      return;
    }

    await reconcileMessages();
  };

  return {
    get threadID() {
      return threadID;
    },

    set threadID(thread) {
      threadID = thread;
    },

    open: async () => {
      try {
        return await openThread(true);
      } catch (error) {
        detachConnection();
        throw error;
      }
    },

    startDelivery: () => {
      delivering = true;
      void reconcileMessages();
    },

    updateThread: (thread) => {
      if (thread !== (pendingThread ?? threadID)) {
        pendingThread = thread;
        endOverloadWait?.();
      }

      scheduleSend(() => updateThreadNow(thread));
    },

    stop: () => {
      stopped = true;

      clearTimeout(retryTimer);
      detachConnection();
    },
  };
}
