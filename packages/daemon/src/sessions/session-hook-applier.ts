import { truncateToBytes } from '@atc/core';
import type { HookPlan } from '@atc/plugin-api';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { match } from 'ts-pattern';
import type { SessionFleetWriter } from '../fleet/session-fleet-writer';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import type { SessionRegistry } from './session-registry';
import { updateRecordIdentity } from './update-record-identity';

interface SessionHookApplierDeps {
  readonly registry: Pick<
    SessionRegistry,
    'sessions' | 'focusedId' | 'findAdapter' | 'requireExecution'
  >;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange' | 'tryWriteFleet' | 'tryUpdateFleetEntry'>;
  readonly callbacks: Pick<SessionCallbacks, 'onEvent' | 'findRecords' | 'log'>;
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
  applyHook(hookEvent: HookEvent, previous?: unknown): HookPlan | null {
    const session = this.registry.sessions.find((x) => x.id === hookEvent.atcId);

    if (!session) {
      return null;
    }

    const adapter = this.registry.findAdapter(session.agent);

    if (adapter === null) {
      return null;
    }

    const plan = adapter.planHookEvents(hookEvent, previous);

    for (const ev of plan.events) {
      this.applyAdapterEvent(session, ev);
    }

    return plan;
  }

  private applyAdapterEvent(session: Session, ev: Readonly<AdapterEvent>): void {
    // Reporters belong to the terminal process; once a session is headless,
    // late reports from the dying terminal must not clobber its state.
    if (session.kind === 'headless') {
      return;
    }

    const focused = this.registry.focusedId === session.id;
    let dirty = false;
    let persist = false;
    const rowUpdate: { result?: string; transcriptPath?: string } = {};

    if (ev.transcriptSource !== undefined) {
      session.transcriptSource = ev.transcriptSource;

      if (session.transcriptPath !== ev.transcriptSource) {
        session.transcriptPath = ev.transcriptSource;
        rowUpdate.transcriptPath = ev.transcriptSource;
        void updateRecordIdentity({ registry: this.registry, callbacks: this.callbacks }, session);
      }
    }

    if (ev.agentSessionID !== undefined && session.agentSessionID !== ev.agentSessionID) {
      session.agentSessionID = ev.agentSessionID;
      persist = true;
      dirty = true;
    }

    if (ev.detail !== undefined) {
      session.lastDetail = ev.detail;
    }

    if (ev.nameSource !== undefined) {
      void this.refreshName(session, ev.nameSource);
    }

    // A permission prompt stays pending until an event shows it closed: a
    // prompt, a finished turn, a start, an end, or an idle notice. A heartbeat
    // or a notice that says nothing about the prompt leaves it pending.
    if (ev.kind === 'needs-input') {
      session.permissionPending = ev.permissionPending ?? session.permissionPending === true;
    } else if (ev.kind !== 'heartbeat') {
      session.permissionPending = false;
    }

    // Each event kind returns whether it changed what the session lists.
    const changed = match(ev.kind)
      .with('started', () => {
        // Clearing or resuming inside a live terminal ends the old agent
        // session and starts a new one in the same process, so the start
        // supersedes the end's message. A gone terminal keeps it.
        if (session.lastMsg === 'adopting…') {
          session.lastMsg = 'adopted';

          return true;
        }

        if (session.lastMsg === 'session ended' && session.pty !== null) {
          session.lastMsg = 'started';

          return true;
        }

        return false;
      })
      .with('needs-input', () => {
        session.state = 'needs_you';
        session.unread = !focused;
        session.lastMsg = ev.message ?? 'needs input';

        return true;
      })
      .with('turn-done', () => {
        session.state = 'done';
        session.unread = !focused;
        session.lastMsg = 'turn done';

        if (ev.result !== undefined) {
          // A runaway final message cannot bloat the fleet row.
          session.result = truncateToBytes(ev.result, 16_384);
          rowUpdate.result = session.result;
        }

        return true;
      })
      .with('prompt-submitted', () => {
        session.state = 'running';
        session.unread = false;
        session.lastMsg = ev.message ?? 'working';

        return true;
      })

      // A live terminal can report an end without dying — resuming claude
      // closes the superseded session while its process stays interactive.
      // Exited is reserved for a gone terminal; onExit owns that transition.
      .with('ended', () => {
        if (session.pty === null) {
          session.state = 'exited';
        }

        session.unread = false;
        session.lastMsg = 'session ended';

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
      void this.fleet.tryWriteFleet(session.id);
    } else {
      void this.fleet.tryUpdateFleetEntry(session.id, rowUpdate);
    }

    if (dirty) {
      this.callbacks.onEvent('state', session);
      this.fleet.emitChange();
    }
  }

  private async refreshName(session: Session, source: string) {
    const adapter = this.registry.findAdapter(session.agent);

    if (adapter === null) {
      return;
    }

    const update = await adapter.loadName(source, session.namedBy);

    if (update === null || update.name === '' || update.name === session.name) {
      return;
    }

    session.name = update.name;

    if (update.namedBy !== undefined) {
      session.namedBy = update.namedBy;
    }

    void this.fleet.tryWriteFleet(session.id);
    void updateRecordIdentity({ registry: this.registry, callbacks: this.callbacks }, session);
    this.callbacks.onEvent('renamed', session);
    this.fleet.emitChange();
  }
}
