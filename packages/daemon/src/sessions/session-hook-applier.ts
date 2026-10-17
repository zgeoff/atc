import { truncateToBytes } from '@atc/core';
import type { HookPlan } from '@atc/plugin-api';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { match } from 'ts-pattern';
import type { SessionFleetWriter } from '../fleet/session-fleet-writer';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionRegistry } from './session-registry';

interface SessionHookApplierDeps {
  readonly registry: Pick<SessionRegistry, 'sessions' | 'focusedId' | 'findAdapter'>;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange' | 'tryWriteFleet' | 'tryUpdateFleetEntry'>;
  readonly callbacks: Pick<SessionCallbacks, 'onEvent'>;
}

export class SessionHookApplier {
  private readonly registry: SessionHookApplierDeps['registry'];

  private readonly fleet: SessionHookApplierDeps['fleet'];

  private readonly callbacks: SessionHookApplierDeps['callbacks'];

  constructor(deps: SessionHookApplierDeps) {
    this.registry = deps.registry;
    this.fleet = deps.fleet;
    this.callbacks = deps.callbacks;
  }

  // the adapter plans from the state it returned for the previous line; the
  // plan goes back so the caller can key its bookkeeping and trail on its
  // events and keep the next state
  applyHook(e: HookEvent, prev?: unknown): HookPlan | null {
    const s = this.registry.sessions.find((x) => x.id === e.atcId);

    if (!s) {
      return null;
    }

    const adapter = this.registry.findAdapter(s.agent);

    if (adapter === null) {
      return null;
    }

    const plan = adapter.planHookEvents(e, prev);

    for (const ev of plan.events) {
      this.applyAdapterEvent(s, ev);
    }

    return plan;
  }

  private applyAdapterEvent(s: Session, ev: Readonly<AdapterEvent>): void {
    // Reporters belong to the terminal process; once a session is headless,
    // late reports from the dying terminal must not clobber its state.
    if (s.kind === 'headless') {
      return;
    }

    const focused = this.registry.focusedId === s.id;
    let dirty = false;
    let persist = false;
    const rowUpdate: { result?: string; transcriptPath?: string } = {};

    if (ev.transcriptSource !== undefined) {
      s.transcriptSource = ev.transcriptSource;

      if (s.transcriptPath !== ev.transcriptSource) {
        s.transcriptPath = ev.transcriptSource;
        rowUpdate.transcriptPath = ev.transcriptSource;
      }
    }

    if (ev.agentSessionID !== undefined && s.agentSessionID !== ev.agentSessionID) {
      s.agentSessionID = ev.agentSessionID;
      persist = true;
      dirty = true;
    }

    if (ev.detail !== undefined) {
      s.lastDetail = ev.detail;
    }

    if (ev.nameSource !== undefined) {
      void this.refreshName(s, ev.nameSource);
    }

    // A permission prompt stays pending until an event shows it closed: a
    // prompt, a finished turn, a start, an end, or an idle notice. A heartbeat
    // or a notice that says nothing about the prompt leaves it pending.
    if (ev.kind === 'needs-input') {
      s.permissionPending = ev.permissionPending ?? s.permissionPending === true;
    } else if (ev.kind !== 'heartbeat') {
      s.permissionPending = false;
    }

    // Each event kind returns whether it changed what the session lists.
    const changed = match(ev.kind)
      .with('started', () => {
        // Clearing or resuming inside a live terminal ends the old agent
        // session and starts a new one in the same process, so the start
        // supersedes the end's message. A gone terminal keeps it.
        if (s.lastMsg === 'adopting…') {
          s.lastMsg = 'adopted';

          return true;
        }

        if (s.lastMsg === 'session ended' && s.pty !== null) {
          s.lastMsg = 'started';

          return true;
        }

        return false;
      })
      .with('needs-input', () => {
        s.state = 'needs_you';
        s.unread = !focused;
        s.lastMsg = ev.message ?? 'needs input';

        return true;
      })
      .with('turn-done', () => {
        s.state = 'done';
        s.unread = !focused;
        s.lastMsg = 'turn done';

        if (ev.result !== undefined) {
          // A runaway final message cannot bloat the fleet row.
          s.result = truncateToBytes(ev.result, 16_384);
          rowUpdate.result = s.result;
        }

        return true;
      })
      .with('prompt-submitted', () => {
        s.state = 'running';
        s.unread = false;
        s.lastMsg = ev.message ?? 'working';

        return true;
      })

      // A live terminal can report an end without dying — resuming claude
      // closes the superseded session while its process stays interactive.
      // Exited is reserved for a gone terminal; onExit owns that transition.
      .with('ended', () => {
        if (s.pty === null) {
          s.state = 'exited';
        }

        s.unread = false;
        s.lastMsg = 'session ended';

        return true;
      })

      // Heartbeats only matter for the agent-session-id capture above.
      .with('heartbeat', () => false)
      .exhaustive();

    dirty ||= changed;

    // A fleet rewrite marks every session without a PTY as exited, so only a
    // new agent session id takes it. Anything else touches this session's
    // own row.
    if (persist) {
      void this.fleet.tryWriteFleet(s.id);
    } else {
      void this.fleet.tryUpdateFleetEntry(s.id, rowUpdate);
    }

    if (dirty) {
      this.callbacks.onEvent('state', s);
      this.fleet.emitChange();
    }
  }

  private async refreshName(s: Session, source: string) {
    const adapter = this.registry.findAdapter(s.agent);

    if (adapter === null) {
      return;
    }

    const update = await adapter.loadName(source, s.namedBy);

    if (update === null || update.name === '' || update.name === s.name) {
      return;
    }

    s.name = update.name;

    if (update.namedBy !== undefined) {
      s.namedBy = update.namedBy;
    }

    void this.fleet.tryWriteFleet(s.id);
    this.callbacks.onEvent('renamed', s);
    this.fleet.emitChange();
  }
}
