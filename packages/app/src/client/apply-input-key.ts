import { applyOverlayKey } from './apply-overlay-key';
import type { OverlayKeyDeps } from './apply-overlay-key';
import type { ClientMode, RestartConsent } from './build-client-machine';
import type { EjectScreen } from './eject-screen';
import { KEY } from './keys';
import type { SpawnPicker } from './spawn-picker';
import type { MirrorSession } from './to-mirror-session';

// What a key from stdin borrows from the client that owns the screen, on top
// of what the overlay's keys borrow.
export interface InputKeyDeps extends OverlayKeyDeps {
  readonly picker: SpawnPicker<MirrorSession>;
  readonly eject: EjectScreen;
  readonly stdinDecoder: TextDecoder;
  readonly getMode: () => ClientMode;
  readonly findFocusedID: () => string | null;
  readonly findRestartConsent: () => RestartConsent | null;
  readonly restoreFleet: () => Promise<void>;
}

export function applyInputKey(buf: Buffer, deps: InputKeyDeps) {
  const pending = deps.findRestartConsent();

  if (pending !== null) {
    deps.service.send({ type: 'CONSENT_ANSWERED' });
    pending.answer(buf.toString());

    return;
  }

  switch (deps.getMode()) {
    case 'attached': {
      if (deps.isLeaderKey(buf)) {
        deps.service.send({ type: 'OVERLAY' });

        return;
      }

      const focusedID = deps.findFocusedID();

      if (focusedID !== null) {
        void deps.sendQuiet('session.input', {
          session: focusedID,
          d: deps.stdinDecoder.decode(buf, { stream: true }),
        });
      }

      return;
    }
    case 'home': {
      if (deps.isLeaderKey(buf)) {
        deps.service.send({ type: 'OVERLAY' });

        return;
      }

      const ch = buf.toString();

      if (ch === 'n') {
        deps.service.send({ type: 'SPAWN', resume: false });

        return;
      }

      if (ch === 'r') {
        deps.service.send({ type: 'SPAWN', resume: true });

        return;
      }

      if (ch === 'R') {
        void deps.restoreFleet();

        return;
      }

      if (ch === 'q' || buf[0] === KEY.ctrlC) {
        deps.quit();
      }

      return;
    }
    case 'overlay': {
      applyOverlayKey(buf, deps);

      return;
    }
    case 'help': {
      applyHelpKey(buf, deps);

      return;
    }
    case 'picker': {
      deps.picker.applyKey(buf);

      return;
    }
    case 'picker-eject': {
      deps.eject.applyKey(buf);
    }
  }
}

function applyHelpKey(buf: Buffer, deps: InputKeyDeps) {
  const ch = buf.toString();

  if (buf[0] === KEY.esc || ch === '?' || ch === 'q' || deps.isLeaderKey(buf)) {
    deps.service.send({ type: 'OVERLAY' });
  }
}
