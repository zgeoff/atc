import type { AgentID, Clock } from '@atc/core';
import { match } from 'ts-pattern';
import type { ClientActor, ClientMode } from './build-client-machine';
import type { FleetMirror } from './create-fleet-mirror';
import type { OverlayScreen } from './create-overlay-screen';
import { parseDaemonEvent } from './parse-daemon-event';
import type { RawDaemonEvent } from './parse-daemon-event';
import type { MirrorSession } from './to-mirror-session';

// What a daemon event borrows from the client that owns the screen and the
// fleet mirror.
export interface DaemonEventDeps {
  readonly service: ClientActor;
  readonly mirror: FleetMirror;
  readonly overlay: OverlayScreen;
  readonly clock: Clock;
  readonly getMode: () => ClientMode;
  readonly findFocusedID: () => string | null;
  readonly setFocusedID: (sessionID: string | null) => void;
  readonly setLastUsedAgent: (agent: AgentID) => void;
  readonly findFocused: () => MirrorSession | null;
  readonly scheduleStatus: () => void;
}

export function applyDaemonEvent(raw: RawDaemonEvent, deps: DaemonEventDeps) {
  const event = parseDaemonEvent(raw);

  if (event === null) {
    return;
  }

  const mirror = deps.mirror;

  match(event)
    .with({ ev: 'SessionOutput' }, (output) => {
      if (deps.getMode() === 'attached' && output.sessionID === deps.findFocusedID()) {
        process.stdout.write(output.data);
      }
    })
    .with({ ev: 'SessionAdded' }, (added) => {
      mirror.upsert(added.session);

      refreshScreens(deps);
    })
    .with({ ev: 'SessionState' }, (changed) => {
      const existing = mirror.sessions.find((x) => x.id === changed.session.id);

      if (existing !== undefined) {
        if (changed.session.state === 'done' && existing.state !== 'done') {
          mirror.doneAt.set(changed.session.id, deps.clock.now());
        }

        if (changed.session.resumable && !existing.resumable) {
          deps.setLastUsedAgent(changed.session.agent);
        }
      }

      mirror.upsert(changed.session);

      refreshScreens(deps);
    })
    .with({ ev: 'SessionRenamed' }, (renamed) => {
      const session = mirror.sessions.find((x) => x.id === renamed.sessionID);

      if (session !== undefined) {
        session.name = renamed.name;
      }

      refreshScreens(deps);
    })
    .with({ ev: 'SessionRemoved' }, (removed) => {
      mirror.sessions = mirror.sessions.filter((x) => x.id !== removed.sessionID);

      mirror.doneAt.delete(removed.sessionID);

      if (deps.findFocusedID() === removed.sessionID) {
        deps.setFocusedID(null);
      }

      refreshScreens(deps);
    })

    // Desync recovery arrives as ordinary repaint output; permission and
    // resize events matter to structured clients, not this passthrough TUI.
    .with(
      { ev: 'SessionResized' },
      { ev: 'SessionDesync' },
      { ev: 'PermissionRequested' },
      { ev: 'PermissionResolved' },
      () => {},
    )
    .exhaustive();
}

function refreshScreens(deps: DaemonEventDeps) {
  const currentMode = deps.getMode();

  if (currentMode === 'overlay') {
    deps.overlay.render();
  }

  // Focused session died under us: surface the list instead of a dead screen.
  const focused = deps.findFocused();

  if (currentMode === 'attached' && focused !== null && focused.state === 'exited') {
    deps.service.send({ type: 'OVERLAY' });
  }

  deps.scheduleStatus();
}
