import type { AgentID, Clock } from '@atc/core';
import type { EventMsg } from '@atc/protocol/wire';
import { match } from 'ts-pattern';
import type { ClientActor, ClientMode } from './build-client-machine';
import type { FleetMirror } from './fleet-mirror';
import type { OverlayScreen } from './overlay-screen';
import { parseDaemonEvent } from './parse-daemon-event';
import type { MirrorSession } from './to-mirror-session';

// What a daemon event borrows from the client that owns the screen and the
// fleet mirror.
export interface DaemonEventDeps {
  readonly service: ClientActor;
  readonly mirror: FleetMirror;
  readonly overlay: OverlayScreen;
  readonly clock: Clock;
  readonly getMode: () => ClientMode;
  readonly getFocusedID: () => string | null;
  readonly setFocusedID: (sessionID: string | null) => void;
  readonly setLastUsedAgent: (agent: AgentID) => void;
  readonly findFocused: () => MirrorSession | null;
  readonly scheduleStatus: () => void;
}

export function applyDaemonEvent(raw: EventMsg, deps: DaemonEventDeps) {
  const event = parseDaemonEvent(raw);

  if (event === null) {
    return;
  }

  const mirror = deps.mirror;

  match(event)
    .with({ ev: 'SessionOutput' }, (e) => {
      if (deps.getMode() === 'attached' && e.s === deps.getFocusedID()) {
        process.stdout.write(e.d);
      }
    })
    .with({ ev: 'SessionAdded' }, (e) => {
      mirror.upsert(e.session);

      refreshScreens(deps);
    })
    .with({ ev: 'SessionState' }, (e) => {
      const existing = mirror.sessions.find((x) => x.id === e.session.id);

      if (existing !== undefined) {
        if (e.session.state === 'done' && existing.state !== 'done') {
          mirror.doneAt.set(e.session.id, deps.clock.now());
        }

        if (e.session.resumable && !existing.resumable) {
          deps.setLastUsedAgent(e.session.agent);
        }
      }

      mirror.upsert(e.session);

      refreshScreens(deps);
    })
    .with({ ev: 'SessionRenamed' }, (e) => {
      const s = mirror.sessions.find((x) => x.id === e.s);

      if (s !== undefined) {
        s.name = e.name;
      }

      refreshScreens(deps);
    })
    .with({ ev: 'SessionRemoved' }, (e) => {
      mirror.sessions = mirror.sessions.filter((x) => x.id !== e.s);

      mirror.doneAt.delete(e.s);

      if (deps.getFocusedID() === e.s) {
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
  const f = deps.findFocused();

  if (currentMode === 'attached' && f !== null && f.state === 'exited') {
    deps.service.send({ type: 'OVERLAY' });
  }

  deps.scheduleStatus();
}
