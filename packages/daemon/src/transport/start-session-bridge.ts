import type { MessageID, SessionID } from '@atc/core';
import { toMessageID } from '@atc/core';
import type { HarnessRelay } from '@atc/plugin-api';
import type { HookEvent } from '@atc/protocol/session';
import type { EventMsg } from '@atc/protocol/wire';
import type { MessageRecord } from '@atc/store';
import { z } from 'zod';
import { isBindingCurrent } from '../auth/is-binding-current';
import type { BridgeBinding } from '../auth/is-binding-current';
import type { TapClient } from '../daemon-context';
import { parseHookLine } from './parse-hook-line';

export interface BridgeSession {
  readonly id: SessionID;
  readonly target: string;
  readonly targetIdentity: string;
  readonly hostKey: SessionID;
  readonly bridgeEpoch: number;
  readonly state: string;
  readonly lastMsg: string;
}

export interface BridgeContext {
  readonly findSession: (sessionID: SessionID) => BridgeSession | undefined;
  readonly applyHookEvent: (hookEvent: HookEvent) => void;

  // Applies a note under the id its reporter gave it, and settles once
  // the note is recorded; false when the payload is no note.
  readonly applyNote: (
    sessionID: SessionID,
    payload: Readonly<Record<string, unknown>>,
    noteID: string,
  ) => Promise<boolean>;
  readonly attachTap: (
    client: TapClient,
    sessionID: SessionID,
    notices: boolean,
  ) => 'ok' | 'missing' | 'unsupported';
  readonly ackMessage: (
    client: TapClient,
    sessionID: SessionID,
    messageID: MessageID,
  ) => Promise<MessageRecord | 'not_tapping' | 'unknown'>;
  readonly ackNotice: (
    client: TapClient,
    sessionID: SessionID,
    messageID: MessageID,
  ) => Promise<MessageRecord | 'not_tapping' | 'unknown'>;
  readonly detachTap: (client: TapClient) => void;
}

const REQUEST_SCHEMA = z.looseObject({
  version: z.literal(1),
  id: z.string().min(1),
  op: z.string(),
});

const NOTE_SCHEMA = z.looseObject({
  noteID: z.string().min(1).max(128),
  payload: z.record(z.string(), z.unknown()),
});

const ACK_SCHEMA = z.looseObject({ message: z.string().min(1) });
const TAP_OPEN_SCHEMA = z.looseObject({ notices: z.boolean().optional() });

type BridgeRefusal = 'forbidden' | 'stale_binding' | 'not_tapping' | 'unknown_message';

// the binding holds no secret: reaching the host's socket proves being inside that host, so
// the per-session socket and binding stop processes crossing sessions by accident, never a
// hostile process inside the same host
export function startSessionBridge(
  relay: HarnessRelay,
  binding: Readonly<BridgeBinding>,
  ctx: BridgeContext,
): void {
  let closed = false;
  let writing: Promise<void> = Promise.resolve();

  // Lines go out one at a time, in the order they were written, and none
  // after the bridge closed.
  const writeLine = async (value: Readonly<Record<string, unknown>>) => {
    const line = JSON.stringify(value);
    const previous = writing;

    writing = (async () => {
      await previous;

      if (!closed) {
        try {
          await relay.writeLine(line);
        } catch {}
      }
    })();

    await writing;
  };

  const stopBridge = () => {
    if (closed) {
      return;
    }

    closed = true;

    ctx.detachTap(tap);
    relay.close();
  };

  // Answers a refusal, then closes once the answer has gone out.
  const answerRefusal = async (id: string | null, code: BridgeRefusal) => {
    await writeLine({ id, ok: false, code });

    stopBridge();
  };

  const tap: TapClient = {
    sendEvent: (event: EventMsg) => {
      void (async () => {
        await writeLine(event);

        if (event.ev === 'InboxClosed') {
          stopBridge();
        }
      })();
    },
  };

  const isCurrent = () => isBindingCurrent(binding, ctx.findSession(binding.sessionID));

  const applyRequest = async (
    request: Readonly<Record<string, unknown>>,
    id: string,
    op: string,
  ) => {
    if (op === 'note') {
      const parsed = NOTE_SCHEMA.safeParse(request);

      if (
        !parsed.success ||
        !(await ctx.applyNote(binding.sessionID, parsed.data.payload, parsed.data.noteID))
      ) {
        void answerRefusal(id, 'forbidden');

        return;
      }

      void writeLine({ id, ok: true });

      return;
    }

    if (op === 'tap.open') {
      const notices = TAP_OPEN_SCHEMA.safeParse(request).data?.notices === true;

      if (ctx.attachTap(tap, binding.sessionID, notices) !== 'ok') {
        void answerRefusal(id, 'forbidden');

        return;
      }

      void writeLine({ id, ok: true });

      return;
    }

    if (op === 'tap.ack' || op === 'tap.notice-ack') {
      const parsed = ACK_SCHEMA.safeParse(request);

      if (!parsed.success) {
        void answerRefusal(id, 'forbidden');

        return;
      }

      const messageID = toMessageID(parsed.data.message);

      const acked =
        op === 'tap.ack'
          ? await ctx.ackMessage(tap, binding.sessionID, messageID)
          : await ctx.ackNotice(tap, binding.sessionID, messageID);

      if (acked === 'not_tapping' || acked === 'unknown') {
        const code: BridgeRefusal = acked === 'unknown' ? 'unknown_message' : 'not_tapping';

        void writeLine({ id, ok: false, code });

        return;
      }

      void writeLine({ id, ok: true, status: acked.status });

      return;
    }

    if (op === 'status.read') {
      const session = ctx.findSession(binding.sessionID);

      void writeLine({
        id,
        ok: true,
        state: session?.state ?? 'exited',
        lastMsg: session?.lastMsg ?? '',
      });

      return;
    }

    void answerRefusal(id, 'forbidden');
  };

  // Lines are applied one at a time, in the order they arrived.
  let applying: Promise<void> = Promise.resolve();

  const applyLine = async (line: string) => {
    if (closed) {
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      void answerRefusal(null, 'forbidden');

      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      void answerRefusal(null, 'forbidden');

      return;
    }

    const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(parsed));

    if (!('op' in record)) {
      const hookEvent = parseHookLine(line);

      if (!isCurrent()) {
        void answerRefusal(null, 'stale_binding');

        return;
      }

      if (hookEvent === null || hookEvent.atcId !== binding.sessionID) {
        void answerRefusal(null, 'forbidden');

        return;
      }

      ctx.applyHookEvent(hookEvent);

      return;
    }

    const request = REQUEST_SCHEMA.safeParse(record);

    if (!request.success) {
      const id = typeof record['id'] === 'string' ? record['id'] : null;

      void answerRefusal(id, 'forbidden');

      return;
    }

    if (!isCurrent()) {
      void answerRefusal(request.data.id, 'stale_binding');

      return;
    }

    await applyRequest(record, request.data.id, request.data.op);
  };

  relay.onLine((line) => {
    const previous = applying;

    applying = (async () => {
      await previous;

      try {
        await applyLine(line);
      } catch {}
    })();
  });

  // A guest that has written its last line gets the answers to the lines before it, then the
  // bridge closes: a host can hold the connection open until the daemon closes it, and takes
  // no new connections once it holds its most.
  relay.onEnd(() => {
    void (async () => {
      await applying;
      await writing;

      stopBridge();
    })();
  });

  relay.onClose(() => {
    closed = true;

    ctx.detachTap(tap);
  });
}
