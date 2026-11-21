import type { AgentID } from '@atc/core';
import type { Clock } from '@zgeoff/std';
import { match } from 'ts-pattern';
import type { ClientActor, ClientMode } from '../client/build-client-machine';
import type { OverlayScreen } from '../overlay/create-overlay-screen';
import type { SessionStream } from '../screen/create-session-stream';
import type { FleetMirror } from './create-fleet-mirror';
import { formatSessionLiveness } from './format-session-liveness';
import { parseDaemonEvent } from './parse-daemon-event';
import type { DaemonEvent, RawDaemonEvent } from './parse-daemon-event';
import { isSameSessionKey } from './session-key';
import type { DaemonName, SessionKey } from './session-key';
import type { MirrorSession } from './to-mirror-session';

export interface DaemonEventDeps {
  readonly service: ClientActor;
  readonly mirror: FleetMirror;
  readonly overlay: Pick<OverlayScreen, 'render'>;
  readonly clock: Pick<Clock, 'now' | 'schedule'>;
  readonly getMode: () => ClientMode;
  readonly findFocusedKey: () => SessionKey | null;
  readonly setFocusedKey: (key: SessionKey | null) => void;
  readonly setLastUsedAgent: (agent: AgentID) => void;
  readonly findFocused: () => MirrorSession | null;
  readonly scheduleStatus: () => void;
  readonly stream: Pick<SessionStream, 'applyEvent'>;

  // a session of the primary daemon came, went, or gained or lost its terminal
  readonly onLivenessChange: () => void;
}

export function applyDaemonEvent(daemon: DaemonName, raw: RawDaemonEvent, deps: DaemonEventDeps) {
  const event = parseDaemonEvent(raw, daemon);

  if (event === null) {
    return;
  }

  const mirror = deps.mirror;
  const livenessBefore = formatSessionLiveness(mirror.sessions, mirror.primary);

  applyParsedEvent(daemon, event, deps);

  if (formatSessionLiveness(mirror.sessions, mirror.primary) !== livenessBefore) {
    deps.onLivenessChange();
  }
}

function applyParsedEvent(daemon: DaemonName, event: DaemonEvent, deps: DaemonEventDeps) {
  const mirror = deps.mirror;

  match(event)
    .with(
      { ev: 'SessionOutput' },
      { ev: 'SessionReplay' },
      { ev: 'SessionDesync' },
      { ev: 'SessionResized' },
      (stream) => {
        deps.stream.applyEvent(daemon, stream);
      },
    )
    .with({ ev: 'SessionAdded' }, (added) => {
      mirror.upsert({ ...added.session, stateSince: deps.clock.now() });

      refreshScreens(deps);
    })
    .with({ ev: 'SessionState' }, (changed) => {
      const existing = mirror.find({ daemon, id: changed.session.id });

      if (existing !== undefined) {
        if (changed.session.state === 'done' && existing.state !== 'done') {
          mirror.doneAt.set({ daemon, id: changed.session.id }, deps.clock.now());
        }

        if (changed.session.resumable && !existing.resumable) {
          deps.setLastUsedAgent(changed.session.agent);
        }
      }

      mirror.upsert(changed.session);

      refreshScreens(deps);
    })
    .with({ ev: 'SessionRenamed' }, (renamed) => {
      const session = mirror.find({ daemon, id: renamed.sessionID });

      if (session !== undefined) {
        session.name = renamed.name;
      }

      refreshScreens(deps);
    })
    .with({ ev: 'SessionRemoved' }, (removed) => {
      const key = { daemon, id: removed.sessionID };

      mirror.sessions = mirror.sessions.filter((x) => !isSameSessionKey(x, key));

      mirror.doneAt.remove(key);

      const focused = deps.findFocusedKey();

      if (focused !== null && isSameSessionKey(focused, key)) {
        deps.setFocusedKey(null);

        // the session behind the list is gone, so the list closes on home
        if (deps.getMode() === 'overlay') {
          deps.service.send({ type: 'HOME' });
        }
      }

      refreshScreens(deps);
    })

    // Permission events matter to structured clients, not to this TUI.
    .with({ ev: 'PermissionRequested' }, { ev: 'PermissionResolved' }, () => {})
    .exhaustive();
}

function refreshScreens(deps: DaemonEventDeps) {
  const currentMode = deps.getMode();

  if (currentMode === 'overlay') {
    deps.overlay.render();
  }

  const focused = deps.findFocused();

  if (currentMode === 'attached' && focused !== null && focused.state === 'exited') {
    deps.service.send({ type: 'OVERLAY' });
  }

  deps.scheduleStatus();
}
