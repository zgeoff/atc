import { ansi } from '@atc/core';
import type { DaemonLinks } from '../daemon-link/create-daemon-links';
import { formatLinkState } from '../daemon-link/daemon-link-state';
import type { FleetMirror } from '../fleet/create-fleet-mirror';
import type { DaemonName, SessionKey } from '../fleet/session-key';
import { toSessionKey } from '../fleet/session-key';
import type { MirrorSession } from '../fleet/to-mirror-session';
import type { EjectScreen } from '../overlay/create-eject-screen';
import type { OverlayScreen } from '../overlay/create-overlay-screen';
import type { SpawnPicker } from '../picker/create-spawn-picker';
import { cols } from '../terminal/cols';
import type { ClientActor, ClientMode } from './build-client-machine';

export interface LinkReactionsDeps {
  readonly primaryName: DaemonName;
  readonly service: ClientActor;
  readonly mirror: FleetMirror;
  readonly links: Pick<DaemonLinks, 'stateOf'>;
  readonly overlay: Pick<OverlayScreen, 'render'>;
  readonly picker: Pick<SpawnPicker, 'isOpenOn' | 'stopFlow' | 'refreshDaemons'>;
  readonly eject: Pick<EjectScreen, 'findTarget'>;
  readonly getMode: () => ClientMode;
  readonly getConfirm: () => string;
  readonly findFocusedKey: () => SessionKey | null;
  readonly findFocused: () => MirrorSession | null;
  readonly write: (chunk: string) => void;
  readonly sendQuiet: (
    daemon: DaemonName,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  readonly ptyRows: () => number;
  readonly showStatusNotice: (text: string) => void;
  readonly scheduleStatus: () => void;
}

export interface LinkReactions {
  // Ends a confirmation or the eject prompt whose session left the list or whose daemon's link
  // left up.
  readonly cancelStaleConfirmations: () => void;

  // What the client does once a daemon's link changes state.
  readonly handleLinkChange: (daemon: DaemonName) => void;
}

export function createLinkReactions(deps: LinkReactionsDeps): LinkReactions {
  // A confirmation or the eject prompt holds the key of the session it opened on, and ends once
  // that session leaves the list or its daemon's link leaves up.
  const isStale = (key: SessionKey): boolean =>
    !deps.mirror.has(toSessionKey(key)) || deps.links.stateOf(key.daemon).kind !== 'up';

  const cancelStaleConfirmations = () => {
    const confirmKey = deps.service.getSnapshot().context.confirmKey;

    if (confirmKey !== null && deps.getConfirm() !== 'none' && isStale(confirmKey)) {
      deps.service.send({ type: 'CONFIRM_DONE' });

      if (deps.getMode() === 'overlay') {
        deps.overlay.render();
      }
    }

    const ejectKey = deps.eject.findTarget();

    if (deps.getMode() === 'picker-eject' && ejectKey !== null && isStale(ejectKey)) {
      deps.service.send({ type: 'OVERLAY' });
    }
  };

  // A remote link that came back reattaches the session on screen when its refreshed list still
  // holds it, and otherwise returns to the list.
  const resumeAttachedSession = (daemon: DaemonName) => {
    const focusedKey = deps.findFocusedKey();

    if (deps.getMode() !== 'attached' || focusedKey === null || focusedKey.daemon !== daemon) {
      return;
    }

    if (deps.links.stateOf(daemon).kind !== 'up') {
      return;
    }

    const focused = deps.findFocused();

    if (focused === null || !focused.alive) {
      deps.service.send({ type: 'OVERLAY' });

      return;
    }

    deps.write(ansi.clear);

    void deps.sendQuiet(daemon, 'session.attach', {
      session: focused.id,
      cols: cols(),
      rows: deps.ptyRows(),
    });
  };

  // A picker open on a remote daemon that leaves `up` ends, and the status bar says where the
  // daemon stands. The primary's own loss already ends the picker.
  const endPickerOn = (daemon: DaemonName) => {
    const state = deps.links.stateOf(daemon);

    if (state.kind === 'up' || deps.getMode() !== 'picker' || !deps.picker.isOpenOn(daemon)) {
      return;
    }

    deps.picker.stopFlow();
    deps.service.send({ type: 'OVERLAY' });
    deps.showStatusNotice(formatLinkState(daemon, state));
  };

  const handleLinkChange = (daemon: DaemonName) => {
    cancelStaleConfirmations();

    deps.picker.refreshDaemons();

    if (daemon !== deps.primaryName) {
      resumeAttachedSession(daemon);
      endPickerOn(daemon);
    }

    if (deps.getMode() === 'overlay') {
      deps.overlay.render();
    }

    deps.scheduleStatus();
  };

  return { cancelStaleConfirmations, handleLinkChange };
}
