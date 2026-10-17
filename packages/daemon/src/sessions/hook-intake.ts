import type { Clock, SessionID } from '@atc/core';
import { truncateToBytes } from '@atc/core';
import type { HarnessRelay } from '@atc/plugin-api';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import type { EventMsg } from '@atc/protocol/wire';
import type { StateStore } from '@atc/store';
import type { BridgeBinding } from '../auth/is-binding-current';
import type { TapClient } from '../daemon-context';
import { formatLogField } from '../format-log-field';
import { ANSWER_BYTE_CAP } from '../transport/answer-byte-cap';
import type { EventSignal } from '../transport/event-signal';
import { startSessionBridge } from '../transport/start-session-bridge';
import { buildMessageOwner } from './build-message-owner';
import { buildNoteTrailEntry } from './build-note-trail-entry';
import { buildSessionNoteEvent } from './build-session-note-event';
import { isOwnHookEvent } from './is-own-hook-event';
import type { HookScope } from './make-hook-runner';
import type { MessageService } from './message-service';
import { parseNote } from './parse-note';
import type { SessionRuntime } from './session-runtime';
import type { SessionManager } from './sessions';
import type { TapRegistry } from './tap-registry';

interface HookIntakeDeps {
  readonly mgr: Pick<SessionManager, 'sessions' | 'findAdapter' | 'applyHook' | 'log'>;
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

  // Called when a Note line changes nothing: a note from a session the
  // fleet does not list, or an answer or unanswered report that matches no
  // unsettled message the reporting session owns.
  readonly onNoteIgnored?: (sessionID: string, kind: 'note' | 'answered' | 'unanswered') => void;

  // Called with a session's id when it reports its start and the daemon
  // leaves the last-used agent as it is, because no spawn is waiting on
  // that start.
  readonly onLastUsedUnchanged?: (sessionID: SessionID) => void;
}

export class HookIntake {
  private readonly mgr: HookIntakeDeps['mgr'];

  private readonly store: HookIntakeDeps['store'];

  private readonly clock: Clock;

  private readonly messages: HookIntakeDeps['messages'];

  private readonly taps: HookIntakeDeps['taps'];

  private readonly findRuntime: HookIntakeDeps['findRuntime'];

  private readonly eventSignal: HookIntakeDeps['eventSignal'];

  private readonly emitEvent: HookIntakeDeps['emitEvent'];

  private readonly findHookScope: HookIntakeDeps['findHookScope'];

  private readonly updateBridgeThread: HookIntakeDeps['updateBridgeThread'];

  private readonly onNoteIgnored: HookIntakeDeps['onNoteIgnored'];

  private readonly onLastUsedUnchanged: HookIntakeDeps['onLastUsedUnchanged'];

  constructor(deps: HookIntakeDeps) {
    this.mgr = deps.mgr;
    this.store = deps.store;
    this.clock = deps.clock;
    this.messages = deps.messages;
    this.taps = deps.taps;
    this.findRuntime = deps.findRuntime;
    this.eventSignal = deps.eventSignal;
    this.emitEvent = deps.emitEvent;
    this.findHookScope = deps.findHookScope;
    this.updateBridgeThread = deps.updateBridgeThread;
    this.onNoteIgnored = deps.onNoteIgnored;
    this.onLastUsedUnchanged = deps.onLastUsedUnchanged;
  }

  applyHookEvent(e: HookEvent): void {
    if (e.event === 'Note') {
      void this.applyNote(e);

      return;
    }

    const before = this.mgr.sessions.find((s) => s.id === e.atcId);
    const runtime = this.findRuntime(e.atcId);

    // A harness nested inside a session inherits its environment and
    // reports under its id; only the harness atc started may change the
    // session, and a line from any other is logged and dropped.
    if (
      before !== undefined &&
      runtime !== undefined &&
      !isOwnHookEvent(
        e.agent,
        this.mgr.findAdapter(before.agent)?.hookAgent ?? before.agent,
        runtime.hasAgentHookLines,
      )
    ) {
      this.mgr.log(
        `atc hook event=dropped session=${formatLogField(e.atcId)} agent=${formatLogField(e.agent ?? '')} hook=${formatLogField(e.event)}`,
      );

      return;
    }

    if (runtime !== undefined && e.agent !== undefined) {
      runtime.hasAgentHookLines = true;
    }

    const previousAgentSessionID = before?.agentSessionID;
    const plan = this.mgr.applyHook(e, runtime?.harnessState);

    if (plan !== null && runtime !== undefined) {
      runtime.harnessState = plan.next;
    }

    const events = plan?.events ?? [];

    // a headless session's trail comes from its runs alone: hook reports from its dying terminal
    // or a run's own CLI stay out; a line records the last event it planned, as the state does
    const trailEvent = before?.kind === 'headless' ? null : (events.at(-1) ?? null);

    if (e.event !== 'Statusline') {
      void this.recordHookEvent(e, trailEvent);
    }

    const currentAgentSessionID = this.mgr.sessions.find((s) => s.id === e.atcId)?.agentSessionID;

    if (currentAgentSessionID !== undefined && currentAgentSessionID !== previousAgentSessionID) {
      void this.store.updateMessageOwner(e.atcId, previousAgentSessionID, currentAgentSessionID);
      void this.store.updateTrailOwner(e.atcId, currentAgentSessionID);
    }

    // only a session start shows the terminal on a conversation: a turn of an older one can still
    // end after the terminal moves on, and the bridge must not follow it back
    if (currentAgentSessionID !== undefined && events.some((ev) => ev.kind === 'started')) {
      this.updateBridgeThread(e.atcId, currentAgentSessionID);
    }

    for (const ev of events) {
      if (ev.kind === 'ended') {
        runtime?.pendingEject?.();
      }

      // A revived session announcing itself is the cue a staggered restore
      // waits on before booting the next one.
      if (ev.kind === 'started') {
        if (runtime !== undefined) {
          runtime.startedAt = this.clock.now();
        }

        runtime?.bootWaiter?.();
        const started = this.mgr.sessions.find((s) => s.id === e.atcId);

        if (started !== undefined && runtime !== undefined && runtime.pendingLastUsed) {
          runtime.pendingLastUsed = false;
          void this.store.writeLastUsedAgent(started.agent);
        } else if (started !== undefined) {
          this.onLastUsedUnchanged?.(started.id);
        }
      }
    }
  }

  // A note id, which a remote session's reporter gives each note, makes a
  // resent note land once; a resent answer changes nothing, since only an
  // unanswered message takes one.
  async applyNote(e: HookEvent, noteID?: string): Promise<void> {
    const note = parseNote(e.payload);

    if (note === null) {
      return;
    }

    if (note.kind === 'note') {
      const sender = this.mgr.sessions.find((x) => x.id === e.atcId);

      if (sender === undefined) {
        this.onNoteIgnored?.(e.atcId, 'note');

        return;
      }

      const capped = { ...note, text: truncateToBytes(note.text, ANSWER_BYTE_CAP) };
      const sentAt = this.clock.now();
      const entry = buildNoteTrailEntry(sender.id, sender.agentSessionID, capped, sentAt, noteID);

      const written = await this.messages.recordTrailEntry(entry);

      if (written) {
        this.emitEvent(
          buildSessionNoteEvent(sender.id, capped, sentAt),
          this.findHookScope(sender.id),
        );
      }

      return;
    }

    const s = this.mgr.sessions.find((x) => x.id === e.atcId);
    const owner = s === undefined ? { atcID: e.atcId } : buildMessageOwner(s);

    try {
      // One statement settles the whole turn, so a reader that sees any
      // member answered already finds every sibling answered beside it.
      const settled =
        note.kind === 'unanswered'
          ? await this.store.updateMessagesUnanswered(
              note.messages,
              owner,
              note.reason,
              this.clock.now(),
              note.turn,
            )
          : await this.store.updateMessagesAnswered(
              note.messages,
              owner,
              truncateToBytes(note.answer, ANSWER_BYTE_CAP),
              this.clock.now(),
              note.turn,
            );

      if (settled.length === 0) {
        this.onNoteIgnored?.(e.atcId, note.kind);
      }

      for (const record of settled) {
        await this.messages.recordMessageStatus(e.atcId, record);
        await this.messages.recordAnswerNotice(record);
      }
    } catch {}
  }

  // A headless turn has no terminal hooks of its own, so the daemon writes
  // its start and end to the trail under a synthetic event name.
  recordHeadlessTurnEvent(sessionID: SessionID, ev: Readonly<AdapterEvent>): void {
    const s = this.mgr.sessions.find((x) => x.id === sessionID);

    void this.recordHookEvent(
      {
        atcId: sessionID,
        event: 'HeadlessTurn',
        payload: s?.agentSessionID === undefined ? {} : { session_id: s.agentSessionID },
      },
      ev,
    );
  }

  // A remote harness reports through a socket that serves it alone, so a
  // line that names any other session is dropped.
  startRelay(binding: BridgeBinding, relay: HarnessRelay): void {
    startSessionBridge(relay, binding, {
      findSession: (sessionID) => this.mgr.sessions.find((x) => x.id === sessionID),
      applyHookEvent: (e) => {
        this.applyHookEvent(e);
      },
      applyNote: async (sessionID, payload, noteID) => {
        if (parseNote(payload) === null) {
          return false;
        }

        await this.applyNote({ atcId: sessionID, event: 'Note', payload: { ...payload } }, noteID);

        return true;
      },
      attachTap: (client, sessionID, notices) =>
        this.messages.attachTap(client, sessionID, null, notices),
      ackMessage: (client, sessionID, messageID) =>
        this.messages.ackMessage(client, sessionID, messageID, null),
      ackNotice: (client, sessionID, messageID) =>
        this.messages.ackNotice(client, sessionID, messageID),
      detachTap: (client) => {
        this.taps.detachAll(client);
      },
    });
  }

  private async recordHookEvent(e: HookEvent, ev: Readonly<AdapterEvent> | null): Promise<void> {
    await this.store.recordEvent(e, ev, this.clock.now());

    this.eventSignal.emit();
  }
}
