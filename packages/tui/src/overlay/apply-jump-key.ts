import { toSessionKey } from '../fleet/session-key';
import type { SessionKey } from '../fleet/session-key';
import { stepJump } from '../session-list/step-jump';
import { KEY } from '../terminal/key';
import type { OverlayScreen } from './create-overlay-screen';
import { readTypedCharacter } from './read-typed-character';

export interface JumpKeyDeps {
  readonly overlay: Pick<OverlayScreen, 'jump' | 'pickSessions' | 'select' | 'render'>;
  readonly attach: (key: SessionKey) => Promise<void>;
}

// A key in jump mode. A letter that is a label acts as enter on its row, and any other letter
// joins the typed letters, which attach the one row they match. Escape leaves jump mode, and backspace takes the last letter back.
export function applyJumpKey(buf: Buffer, deps: JumpKeyDeps): void {
  const overlay = deps.overlay;
  const jump = overlay.jump;

  if (jump === null) {
    return;
  }

  if (buf[0] === KEY.esc && buf.length === 1) {
    overlay.jump = null;

    overlay.render();

    return;
  }

  if (buf[0] === KEY.backspace) {
    overlay.jump =
      jump.prefix === ''
        ? { typed: jump.typed.slice(0, -1), prefix: '' }
        : { typed: jump.typed, prefix: '' };

    overlay.render();

    return;
  }

  const character = readTypedCharacter(buf);

  if (character === null) {
    return;
  }

  const sessions = overlay.pickSessions();

  const step = stepJump(
    jump,
    character,
    sessions.map((session) => session.name),
  );

  if (step.kind === 'continue') {
    overlay.jump = step.state;

    overlay.render();

    return;
  }

  const picked = sessions[step.index];

  overlay.select(step.index);

  overlay.jump = null;

  overlay.render();

  if (picked?.alive === true) {
    void deps.attach(toSessionKey(picked));
  }
}
