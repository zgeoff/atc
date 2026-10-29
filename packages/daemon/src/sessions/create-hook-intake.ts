import type { Clock } from '@atc/core';
import { isRecord, truncateToBytes } from '@atc/core';
import type { HarnessRelay } from '@atc/plugin-api';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import type { EventMsg } from '@atc/protocol/wire';
import type { StateStore } from '@atc/store';
import type { SessionID } from '@atcx/contract';
import type { BridgeBinding } from '../auth/is-binding-current';
import type { TapClient } from '../daemon-context';
import { formatLogField } from '../format-log-field';
import { ANSWER_BYTE_CAP } from '../transport/answer-byte-cap';
import type { EventSignal } from '../transport/create-event-signal';
import { startSessionBridge } from '../transport/start-session-bridge';
import { buildMessageOwner } from './build-message-owner';
import { buildNoteTrailEntry } from './build-note-trail-entry';
import { buildSessionNoteEvent } from './build-session-note-event';
import type { MessageService } from './create-message-service';
import type { SessionManager } from './create-session-manager';
import type { SessionRuntime } from './create-session-runtime';
import type { TapRegistry } from './create-tap-registry';
import { isOwnHookEvent } from './is-own-hook-event';
import type { HookScope } from './make-hook-runner';
import { parseNote } from './parse-note';

interface HookIntakeDeps {
  readonly manager: Pick<SessionManager, 'sessions' | 'findAdapter' | 'applyHook' | 'log'>;
  readonly store: Pick<
    StateStore,
    | 'recordEvent'
    | 'updateMessageOwner'
    | 'updateTrailOwner'
    | 'writeLastUsedAgent'
    | 'updateMessagesAnswered'
    | 'updateMessagesUnanswered'
  >;
  readonly clock: Clock;
  readonly messages: Pick<
    MessageService,
    | 'recordTrailEntry'
    | 'recordMessageStatus'
    | 'recordAnswerNotice'
    | 'attachTap'
    | 'ackMessage'
    | 'ackNotice'
  >;
  readonly taps: Pick<TapRegistry<TapClient>, 'detachAll'>;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;

  // Wakes the reads that wait for the trail to grow.
  readonly eventSignal: Pick<EventSignal, 'emit'>;
  readonly emitEvent: (event: EventMsg, scope: HookScope | null) => void;
  readonly findHookScope: (sessionID: SessionID) => HookScope | null;

  // Moves the session's message bridge to the conversation its terminal
  // shows.
  readonly updateBridgeThread: (sessionID: SessionID, agentSessionID: string) => void;

  readonly onAgentStarted: (sessionID: SessionID) => void;

  // Called when a Note line changes nothing: a note from a session the
  // fleet does not list, or an answer or unanswered report that matches no
  // unsettled message the reporting session owns.
  readonly onNoteIgnored?: (sessionID: string, kind: 'note' | 'answered' | 'unanswered') => void;

  // Called with a session's id when it reports its start and the daemon
  // leaves the last-used agent as it is, because no spawn is waiting on
  // that start.
  readonly onLastUsedUnchanged?: (sessionID: SessionID) => void;
}

export interface HookIntake {
  readonly applyHookEvent: (hookEvent: HookEvent) => void;

  // A note id, which a remote session's reporter gives each note, makes a
  // resent note land once; a resent answer changes nothing, since only an
  // unanswered message takes one.
  readonly applyNote: (hookEvent: HookEvent, noteID?: string) => Promise<void>;

  // A headless turn has no terminal hooks of its own, so the daemon writes
  // its start and end to the trail under a synthetic event name.
  readonly recordHeadlessTurnEvent: (sessionID: SessionID, ev: Readonly<AdapterEvent>) => void;
  readonly recordScreenNeedsInput: (sessionID: SessionID, message: string) => Promise<boolean>;

  // A remote harness reports through a socket that serves it alone, so a
  // line that names any other session is dropped.
  readonly startRelay: (binding: BridgeBinding, relay: HarnessRelay) => void;
}

export function createHookIntake(deps: HookIntakeDeps): HookIntake {
  const manager = deps.manager;
  const store = deps.store;
  const clock = deps.clock;
  const messages = deps.messages;
  const taps = deps.taps;
  const findRuntime = deps.findRuntime;
  const eventSignal = deps.eventSignal;
  const emitEvent = deps.emitEvent;
  const findHookScope = deps.findHookScope;
  const updateBridgeThread = deps.updateBridgeThread;
  const onAgentStarted = deps.onAgentStarted;
  const onNoteIgnored = deps.onNoteIgnored;
  const onLastUsedUnchanged = deps.onLastUsedUnchanged;

  const recordHookEvent = async (
    hookEvent: HookEvent,
    ev: Readonly<AdapterEvent> | null,
  ): Promise<void> => {
    await store.recordEvent(hookEvent, ev, clock.now());

    eventSignal.emit();
  };

  const applyNote = async (hookEvent: HookEvent, noteID?: string): Promise<void> => {
    const note = isRecord(hookEvent.payload) ? parseNote(hookEvent.payload) : null;

    if (note === null) {
      return;
    }

    if (note.kind === 'note') {
      const sender = manager.sessions.find((x) => x.id === hookEvent.atcId);

      if (sender === undefined) {
        onNoteIgnored?.(hookEvent.atcId, 'note');

        return;
      }

      const capped = { ...note, text: truncateToBytes(note.text, ANSWER_BYTE_CAP) };
      const sentAt = clock.now();

      const entry = buildNoteTrailEntry({
        sessionID: sender.id,
        agentSessionID: sender.agentSessionID,
        note: capped,
        sentAt,
        noteID,
      });

      const written = await messages.recordTrailEntry(entry);

      if (written) {
        emitEvent(buildSessionNoteEvent(sender.id, capped, sentAt), findHookScope(sender.id));
      }

      return;
    }

    const session = manager.sessions.find((x) => x.id === hookEvent.atcId);
    const owner = session === undefined ? { atcID: hookEvent.atcId } : buildMessageOwner(session);

    try {
      // One statement settles the whole turn, so a reader that sees any
      // member answered already finds every sibling answered beside it.
      const settled =
        note.kind === 'unanswered'
          ? await store.updateMessagesUnanswered(note.messages, owner, {
              reason: note.reason,
              at: clock.now(),
              turn: note.turn,
            })
          : await store.updateMessagesAnswered(note.messages, owner, {
              answer: truncateToBytes(note.answer, ANSWER_BYTE_CAP),
              at: clock.now(),
              turn: note.turn,
            });

      if (settled.length === 0) {
        onNoteIgnored?.(hookEvent.atcId, note.kind);
      }

      for (const record of settled) {
        await messages.recordMessageStatus(hookEvent.atcId, record);
        await messages.recordAnswerNotice(record);
      }
    } catch {}
  };

  const applyHookEvent = (hookEvent: HookEvent): void => {
    if (hookEvent.event === 'Note') {
      void applyNote(hookEvent);

      return;
    }

    const before = manager.sessions.find((session) => session.id === hookEvent.atcId);
    const runtime = findRuntime(hookEvent.atcId);

    // A harness nested inside a session inherits its environment and
    // reports under its id; only the harness atc started may change the
    // session, and a line from any other is logged and dropped.
    if (
      before !== undefined &&
      runtime !== undefined &&
      !isOwnHookEvent(
        hookEvent.agent,
        manager.findAdapter(before.agent)?.hookAgent ?? before.agent,
        runtime.hasAgentHookLines,
      )
    ) {
      manager.log(
        `atc hook event=dropped session=${formatLogField(hookEvent.atcId)} agent=${formatLogField(hookEvent.agent ?? '')} hook=${formatLogField(hookEvent.event)}`,
      );

      return;
    }

    if (runtime !== undefined && hookEvent.agent !== undefined) {
      runtime.hasAgentHookLines = true;
    }

    const previousAgentSessionID = before?.agentSessionID;
    const plan = manager.applyHook(hookEvent, runtime?.harnessState);

    if (plan !== null && runtime !== undefined) {
      runtime.harnessState = plan.next;
    }

    const events = plan?.events ?? [];

    // a headless session's trail comes from its runs alone: hook reports from its dying terminal
    // or a run's own CLI stay out; a line records the last event it planned, as the state does
    const trailEvent = before?.kind === 'headless' ? null : (events.at(-1) ?? null);

    if (hookEvent.event !== 'Statusline') {
      void recordHookEvent(hookEvent, trailEvent);
    }

    const currentAgentSessionID = manager.sessions.find(
      (session) => session.id === hookEvent.atcId,
    )?.agentSessionID;

    if (currentAgentSessionID !== undefined && currentAgentSessionID !== previousAgentSessionID) {
      void store.updateMessageOwner(hookEvent.atcId, previousAgentSessionID, currentAgentSessionID);
      void store.updateTrailOwner(hookEvent.atcId, currentAgentSessionID);
    }

    // only a session start shows the terminal on a conversation: a turn of an older one can still
    // end after the terminal moves on, and the bridge must not follow it back
    if (currentAgentSessionID !== undefined && events.some((ev) => ev.kind === 'started')) {
      updateBridgeThread(hookEvent.atcId, currentAgentSessionID);
    }

    for (const ev of events) {
      if (ev.kind === 'ended') {
        runtime?.pendingEject?.();
      }

      // A revived session announcing itself is the cue a staggered restore
      // waits on before booting the next one.
      if (ev.kind === 'started') {
        if (runtime !== undefined) {
          runtime.startedAt = clock.now();
        }

        runtime?.bootWaiter?.();
        onAgentStarted(hookEvent.atcId);

        const started = manager.sessions.find((session) => session.id === hookEvent.atcId);

        if (started !== undefined && runtime !== undefined && runtime.pendingLastUsed) {
          runtime.pendingLastUsed = false;
          void store.writeLastUsedAgent(started.agent);
        } else if (started !== undefined) {
          onLastUsedUnchanged?.(started.id);
        }
      }
    }
  };

  return {
    applyHookEvent,

    applyNote,

    recordHeadlessTurnEvent: (sessionID, ev) => {
      const session = manager.sessions.find((x) => x.id === sessionID);

      void recordHookEvent(
        {
          atcId: sessionID,
          event: 'HeadlessTurn',
          payload:
            session?.agentSessionID === undefined ? {} : { session_id: session.agentSessionID },
        },
        ev,
      );
    },

    recordScreenNeedsInput: async (sessionID, message) => {
      const session = manager.sessions.find((x) => x.id === sessionID);

      try {
        await recordHookEvent(
          {
            atcId: sessionID,
            event: 'Screen',
            payload: {
              message,
              ...(session?.agentSessionID === undefined
                ? {}
                : { session_id: session.agentSessionID }),
            },
          },
          { kind: 'needs-input', message, detail: message },
        );

        return true;
      } catch (error) {
        manager.log(
          `atc screen event=unrecorded session=${formatLogField(sessionID)} error=${formatLogField(String(error))}`,
        );

        return false;
      }
    },

    startRelay: (binding, relay) => {
      startSessionBridge(relay, binding, {
        findSession: (sessionID) => manager.sessions.find((x) => x.id === sessionID),
        applyHookEvent: (hookEvent) => {
          applyHookEvent(hookEvent);
        },
        applyNote: async (sessionID, payload, noteID) => {
          if (parseNote(payload) === null) {
            return false;
          }

          await applyNote({ atcId: sessionID, event: 'Note', payload: { ...payload } }, noteID);

          return true;
        },
        attachTap: (client, sessionID, notices) =>
          messages.attachTap(client, sessionID, null, notices),
        ackMessage: (client, sessionID, messageID) =>
          messages.ackMessage(client, sessionID, messageID, null),
        ackNotice: (client, sessionID, messageID) =>
          messages.ackNotice(client, sessionID, messageID),
        detachTap: (client) => {
          taps.detachAll(client);
        },
      });
    },
  };
}
