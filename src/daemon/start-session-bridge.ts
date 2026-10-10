import { z } from 'zod';
import type { HookEvent } from '../protocol/hook-event';
import type { EventMsg } from '../protocol/protocol';
import type { MessageID } from '../shared/message-id';
import type { SessionID } from '../shared/session-id';
import { toMessageID } from '../shared/to-message-id';
import type { MessageRecord } from '../store/message-record';
import type { TapClient } from './daemon-context';
import type { HarnessRelay } from './execution-provider';
import { isBindingCurrent } from './is-binding-current';
import type { BridgeBinding } from './is-binding-current';
import { parseHookLine } from './parse-hook-line';

/**
 * The fields of a live session the bridge checks its binding against and
 * reads the status from.
 */
export interface BridgeSession {
  readonly id: SessionID;
  readonly target: string;
  readonly targetIdentity: string;
  readonly hostKey: SessionID;
  readonly bridgeEpoch: number;
  readonly state: string;
  readonly lastMsg: string;
}

/**
 * What the bridge needs from the daemon. Each operation acts on the one
 * session the caller names, which is always the bridge's own.
 */
export interface BridgeContext {
  readonly findSession: (sessionID: SessionID) => BridgeSession | undefined;
  readonly applyHookEvent: (e: HookEvent) => void;

  // Applies a note under the id its reporter gave it, and settles once
  // the note is recorded; false when the payload is no note.
  readonly applyNote: (
    sessionID: SessionID,
    payload: Readonly<Record<string, unknown>>,
    noteID: string,
  ) => Promise<boolean>;
  readonly attachTap: (client: TapClient, sessionID: SessionID) => 'ok' | 'missing' | 'unsupported';
  readonly ackMessage: (
    client: TapClient,
    sessionID: SessionID,
    messageID: MessageID,
  ) => Promise<MessageRecord | 'not_tapping' | 'unknown'>;
  readonly detachTap: (client: TapClient) => void;
}

const REQUEST_SCHEMA = z.looseObject({ v: z.literal(1), id: z.string().min(1), op: z.string() });

const REPORT_SCHEMA = z.looseObject({
  noteID: z.string().min(1).max(128),
  payload: z.record(z.string(), z.unknown()),
});

const ACK_SCHEMA = z.looseObject({ message: z.string().min(1) });

type BridgeRefusal = 'forbidden' | 'stale_binding' | 'not_tapping' | 'unknown_message';

/**
 * Serves one connection a remote harness's processes opened to the daemon:
 * the session bridge. A line without an `op` is a hook line, as the local
 * reporter socket takes it. A request line `{ v: 1, id, op }` gets one
 * answer line `{ id, ok }`, and the bridge's own inbox events go out as
 * protocol event lines.
 *
 * The bridge takes hooks, notes, its session's tap and acks, and its
 * session's own status, for the one session it was bound to and nothing
 * else: an unknown op, a malformed request, or a note or hook for any
 * other session answers `forbidden` and closes the connection. Every line
 * checks the binding against the live session first, and one that no
 * longer matches answers `stale_binding` and closes.
 *
 * Trust: the binding holds no secret. A host serves the bridge's socket
 * inside itself alone, so reaching the socket is the proof of being inside
 * that host. One host is one trust domain: a sub-session in its parent's
 * host runs as the same user and can reach the parent's socket too. The
 * per-session socket and binding stop processes in the host from crossing
 * sessions by accident, never a hostile process inside the same host.
 */
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
      const parsed = REPORT_SCHEMA.safeParse(request);

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
      if (ctx.attachTap(tap, binding.sessionID) !== 'ok') {
        void answerRefusal(id, 'forbidden');

        return;
      }

      void writeLine({ id, ok: true });

      return;
    }

    if (op === 'tap.ack') {
      const parsed = ACK_SCHEMA.safeParse(request);

      if (!parsed.success) {
        void answerRefusal(id, 'forbidden');

        return;
      }

      const acked = await ctx.ackMessage(tap, binding.sessionID, toMessageID(parsed.data.message));

      if (acked === 'not_tapping' || acked === 'unknown') {
        const code: BridgeRefusal = acked === 'unknown' ? 'unknown_message' : 'not_tapping';

        void writeLine({ id, ok: false, code });

        return;
      }

      void writeLine({ id, ok: true, status: acked.status });

      return;
    }

    if (op === 'status.read') {
      const s = ctx.findSession(binding.sessionID);

      void writeLine({ id, ok: true, state: s?.state ?? 'exited', lastMsg: s?.lastMsg ?? '' });

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
      const e = parseHookLine(line);

      if (!isCurrent()) {
        void answerRefusal(null, 'stale_binding');

        return;
      }

      if (e === null || e.atcId !== binding.sessionID) {
        void answerRefusal(null, 'forbidden');

        return;
      }

      ctx.applyHookEvent(e);

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

  relay.onClose(() => {
    closed = true;

    ctx.detachTap(tap);
  });
}
