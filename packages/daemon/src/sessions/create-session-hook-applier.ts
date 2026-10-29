import { truncateToBytes } from '@atc/core';
import { buildHostFiles } from '@atc/plugin-api';
import type { ExecutionProvider, HookPlan, HostFiles, SessionHost } from '@atc/plugin-api';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import type { FleetStore } from '@atc/store';
import type { AgentSessionID } from '@atcx/contract';
import { match } from 'ts-pattern';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import type { SessionRegistry } from './create-session-registry';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import { updateRecordIdentity } from './update-record-identity';

interface SessionHookApplierDeps {
  readonly registry: Pick<
    SessionRegistry,
    | 'sessions'
    | 'focusedId'
    | 'findAdapter'
    | 'findProvider'
    | 'findExecutionRefusal'
    | 'requireExecution'
  >;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange' | 'tryWriteFleet' | 'tryUpdateFleetEntry'>;
  readonly store: Pick<FleetStore, 'readAgentSessionHolders'>;
  readonly callbacks: Pick<SessionCallbacks, 'onEvent' | 'findRecords' | 'log'>;
}

export interface SessionHookApplier {
  // the adapter plans from the state it returned for the previous line; the
  // plan goes back so the caller can key its bookkeeping and trail on its
  // events and keep the next state
  readonly applyHook: (hookEvent: HookEvent, previous?: unknown) => HookPlan | null;
}

export function createSessionHookApplier(deps: SessionHookApplierDeps): SessionHookApplier {
  const registry = deps.registry;
  const fleet = deps.fleet;
  const callbacks = deps.callbacks;

  const refreshName = async (session: Session, source: string) => {
    const adapter = registry.findAdapter(session.agent);

    if (adapter === null) {
      return;
    }

    const provider = registry.findProvider(session);

    // a remote read runs a command on the session's target, which reads nothing once the target
    // the session was bound to changed or went away
    if (provider?.remote === true && registry.findExecutionRefusal(session, 'run') !== null) {
      return;
    }

    const update = await adapter.loadName(
      source,
      session.namedBy,
      buildSessionHost(session, provider),
    );

    if (update === null || update.name === '' || update.name === session.name) {
      return;
    }

    session.name = update.name;

    if (update.namedBy !== undefined) {
      session.namedBy = update.namedBy;
    }

    void fleet.tryWriteFleet(session.id);
    void updateRecordIdentity({ registry, callbacks }, session);
    callbacks.onEvent('renamed', session);
    fleet.emitChange();
  };

  // A conversation on another host never resumes on this one, so a remote
  // session keeps its own agent session id when a session on another host
  // holds the one it reports, whether that session is live or only stored.
  const claimRemoteAgentSession = async (
    session: Session,
    agentSessionID: AgentSessionID,
  ): Promise<void> => {
    let isHeldElsewhere = true;

    try {
      const holders = await deps.store.readAgentSessionHolders(agentSessionID);

      isHeldElsewhere =
        holders.some(
          (holder) => holder.sessionID !== session.id && holder.hostKey !== session.hostKey,
        ) ||
        registry.sessions.some(
          (other) =>
            other.id !== session.id &&
            other.hostKey !== session.hostKey &&
            other.agentSessionID === agentSessionID,
        );
    } catch (error) {
      callbacks.log(
        `session ${session.id} could not check agent session ${agentSessionID}: ${String(error)}`,
      );
    }

    if (session.agentSessionID === agentSessionID) {
      return;
    }

    if (isHeldElsewhere) {
      callbacks.log(
        `session ${session.id} reported agent session ${agentSessionID}, which a session on another host holds; the report keeps its own`,
      );

      return;
    }

    session.agentSessionID = agentSessionID;
    void fleet.tryWriteFleet(session.id);
    callbacks.onEvent('state', session);
    fleet.emitChange();
  };

  const applyAdapterEvent = (session: Session, ev: Readonly<AdapterEvent>): void => {
    // Reporters belong to the terminal process; once a session is headless,
    // late reports from the dying terminal must not clobber its state.
    if (session.kind === 'headless') {
      return;
    }

    const focused = registry.focusedId === session.id;
    let dirty = false;
    let persist = false;
    const rowUpdate: { result?: string; transcriptPath?: string } = {};

    if (ev.transcriptSource !== undefined) {
      session.transcriptSource = ev.transcriptSource;

      if (session.transcriptPath !== ev.transcriptSource) {
        session.transcriptPath = ev.transcriptSource;
        rowUpdate.transcriptPath = ev.transcriptSource;
        void updateRecordIdentity({ registry, callbacks }, session);
      }
    }

    if (ev.agentSessionID !== undefined && session.agentSessionID !== ev.agentSessionID) {
      if (registry.findProvider(session)?.remote === true) {
        void claimRemoteAgentSession(session, ev.agentSessionID);
      } else {
        session.agentSessionID = ev.agentSessionID;
        persist = true;
        dirty = true;
      }
    }

    if (ev.detail !== undefined) {
      session.lastDetail = ev.detail;
    }

    if (ev.nameSource !== undefined) {
      void refreshName(session, ev.nameSource);
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
      void fleet.tryWriteFleet(session.id);
    } else {
      void fleet.tryUpdateFleetEntry(session.id, rowUpdate);
    }

    if (dirty) {
      callbacks.onEvent('state', session);
      fleet.emitChange();
    }
  };

  return {
    applyHook: (hookEvent, previous) => {
      const session = registry.sessions.find((x) => x.id === hookEvent.atcId);

      if (!session) {
        return null;
      }

      const adapter = registry.findAdapter(session.agent);

      if (adapter === null) {
        return null;
      }

      const plan = adapter.planHookEvents(
        hookEvent,
        previous,
        buildSessionHost(session, registry.findProvider(session)),
      );

      for (const ev of plan.events) {
        applyAdapterEvent(session, ev);
      }

      return plan;
    },
  };
}

// the session's target is gone, so nothing reaches its host
const UNREACHABLE_HOST_FILES: HostFiles = {
  readMatchingLines: () => Promise.resolve(null),
  readDirectory: () => Promise.resolve(null),
};

function buildSessionHost(session: Session, provider: ExecutionProvider | null): SessionHost {
  return {
    files:
      provider === null
        ? UNREACHABLE_HOST_FILES
        : buildHostFiles(provider.runCommand, session.hostKey),
    agentHome: session.agentHome ?? null,
  };
}
