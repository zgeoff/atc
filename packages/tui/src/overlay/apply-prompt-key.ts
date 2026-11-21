import type { ClientActor } from '../client/build-client-machine';
import type { SessionActions } from '../client/create-session-actions';
import type { DaemonLinks } from '../daemon-link/create-daemon-links';
import type { FleetMirror } from '../fleet/create-fleet-mirror';
import { toSessionKey } from '../fleet/session-key';
import { KEY } from '../terminal/key';
import type { OverlayConfirm, OverlayScreen } from './create-overlay-screen';

export interface PromptKeyDeps {
  readonly service: ClientActor;
  readonly mirror: FleetMirror;
  readonly overlay: Pick<OverlayScreen, 'render'>;
  readonly actions: Pick<SessionActions, 'sendKill' | 'sendEnd'>;
  readonly links: Pick<DaemonLinks, 'stateOf'>;
}

// The answer to the question on the panel's last line. `y` confirms it, and any other key drops
// it.
export function applyPromptKey(
  buf: Buffer,
  confirm: Exclude<OverlayConfirm, 'none'>,
  deps: PromptKeyDeps,
): void {
  const confirmKey = deps.service.getSnapshot().context.confirmKey;

  const subject =
    confirmKey !== null && deps.links.stateOf(confirmKey.daemon).kind === 'up'
      ? deps.mirror.find(toSessionKey(confirmKey))
      : undefined;

  if (buf[0] === KEY.y && confirmKey !== null && subject !== undefined) {
    if (confirm === 'kill') {
      if (subject.alive) {
        void deps.actions.sendKill(toSessionKey(confirmKey));
      }
    } else {
      const namesMachine = confirm === 'destroy' || subject.canDestroyHost === true;

      void deps.actions.sendEnd(toSessionKey(confirmKey), namesMachine);
    }
  }

  deps.service.send({ type: 'CONFIRM_DONE' });
  deps.overlay.render();
}
