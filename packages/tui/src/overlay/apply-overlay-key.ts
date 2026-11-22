import type { DaemonBoot } from '@atc/protocol';
import type { ClientActor } from '../client/build-client-machine';
import type { SessionActions } from '../client/create-session-actions';
import type { DaemonLinks } from '../daemon-link/create-daemon-links';
import type { FleetMirror } from '../fleet/create-fleet-mirror';
import { toSessionKey } from '../fleet/session-key';
import type { SessionKey } from '../fleet/session-key';
import type { MirrorSession } from '../fleet/to-mirror-session';
import type { Grouping } from '../session-list/types';
import { KEY, isDown, isUp } from '../terminal/key';
import { applyJumpKey } from './apply-jump-key';
import { applyPromptKey } from './apply-prompt-key';
import type { OverlayConfirm, OverlayScreen } from './create-overlay-screen';
import { pickPinTarget } from './pick-pin-target';
import { pickTabTarget } from './pick-tab-target';

export interface OverlayKeyDeps {
  readonly service: ClientActor;
  readonly mirror: FleetMirror;
  readonly overlay: Pick<
    OverlayScreen,
    | 'notice'
    | 'render'
    | 'pickSessions'
    | 'listVisible'
    | 'selected'
    | 'select'
    | 'syncSelection'
    | 'filter'
    | 'grouping'
    | 'jump'
    | 'readShownSessions'
  >;
  readonly actions: SessionActions;
  readonly links: Pick<DaemonLinks, 'stateOf'>;
  readonly getConfirm: () => OverlayConfirm;
  readonly getBoot: () => Pick<DaemonBoot, 'stale'>;
  readonly isLeaderKey: (buf: Buffer) => boolean;
  readonly showBase: () => void;
  readonly attach: (key: SessionKey) => Promise<void>;
  readonly restartDaemonOnce: () => Promise<void>;
  readonly logClientEvent: (line: string) => void;
  readonly quit: () => void;
}

export function applyOverlayKey(buf: Buffer, deps: OverlayKeyDeps) {
  if (deps.overlay.notice !== null) {
    deps.overlay.notice = null;

    deps.overlay.render();
  }

  const confirm = dropVanishedPrompt(deps);

  if (deps.isLeaderKey(buf)) {
    if (confirm !== 'none') {
      deps.service.send({ type: 'CONFIRM_DONE' });
    }

    deps.showBase();

    return;
  }

  if (confirm !== 'none') {
    applyPromptKey(buf, confirm, deps);

    return;
  }

  if (deps.overlay.jump !== null) {
    applyJumpKey(buf, deps);

    return;
  }

  if (applyOverlayFilterKey(buf, deps)) {
    return;
  }

  applyListKey(buf, deps);
}

// The list stops showing a prompt once its session leaves the fleet, so the prompt must not take
// the next key either.
function dropVanishedPrompt(deps: OverlayKeyDeps): OverlayConfirm {
  const confirm = deps.getConfirm();
  const confirmKey = deps.service.getSnapshot().context.confirmKey;

  if (confirm === 'none' || (confirmKey !== null && deps.mirror.has(confirmKey))) {
    return confirm;
  }

  deps.service.send({ type: 'CONFIRM_DONE' });

  return 'none';
}

function applyOverlayFilterKey(buf: Buffer, deps: OverlayKeyDeps): boolean {
  const overlay = deps.overlay;

  if (overlay.filter === null) {
    return false;
  }

  if (buf[0] === KEY.esc && buf.length === 1) {
    overlay.filter = null;

    overlay.render();

    return true;
  }

  if (buf[0] === KEY.backspace) {
    overlay.filter = overlay.filter.slice(0, -1);

    overlay.select(0);
    overlay.render();

    return true;
  }

  if (buf[0] === KEY.ctrlU) {
    overlay.filter = '';

    overlay.select(0);
    overlay.render();

    return true;
  }

  if (buf[0] === KEY.enter || isUp(buf) || isDown(buf)) {
    return false;
  }

  const text = buf.toString();
  let printable = text.length > 0;

  for (const character of text) {
    if (character < ' ' || character === '\u007F') {
      printable = false;
      break;
    }
  }

  if (printable) {
    overlay.filter += text;

    overlay.select(0);
    overlay.render();
  }

  return true;
}

const NEXT_GROUPING: Readonly<Record<Grouping, Grouping>> = {
  flat: 'repo',
  repo: 'place',
  place: 'flat',
};

function applyListKey(buf: Buffer, deps: OverlayKeyDeps) {
  const overlay = deps.overlay;
  const filtered = overlay.syncSelection();
  const sel = filtered[overlay.selected];
  const ch = buf.toString();

  if (ch === '/') {
    overlay.filter = '';

    overlay.select(0);
    overlay.render();

    return;
  }

  if (buf[0] === KEY.esc && buf.length === 1) {
    deps.showBase();

    return;
  }

  if (isDown(buf) || ch === 'j') {
    overlay.select(Math.min(filtered.length - 1, overlay.selected + 1));
    overlay.render();

    return;
  }

  if (isUp(buf) || ch === 'k') {
    overlay.select(Math.max(0, overlay.selected - 1));
    overlay.render();

    return;
  }

  if (buf[0] === KEY.tab) {
    const target = pickTabTarget(overlay.listVisible(), (key) => deps.mirror.doneAt.get(key));

    if (target !== undefined) {
      void deps.attach(toSessionKey(target));
    }

    return;
  }

  if (buf[0] === KEY.enter && sel !== undefined && sel.alive) {
    void deps.attach(toSessionKey(sel));

    return;
  }

  if (ch === 'f' && filtered.length > 0) {
    overlay.jump = { typed: '', prefix: '' };

    overlay.render();

    return;
  }

  if (ch === 'g') {
    overlay.grouping = NEXT_GROUPING[overlay.grouping];

    overlay.render();

    return;
  }

  if (ch === 'i') {
    deps.service.send({ type: 'HOME' });

    return;
  }

  if (ch === 'p' && sel !== undefined) {
    const target = pickPinTarget(sel, deps.mirror.sessions);

    target.pinned = !target.pinned;
    void deps.actions.sendPinned(toSessionKey(target), target.pinned);
    overlay.render();

    return;
  }

  if (ch === 'K' && sel?.alive === true) {
    deps.service.send({ type: 'CONFIRM_KILL', key: toSessionKey(sel) });
    overlay.render();

    return;
  }

  if (ch === 'X' && sel !== undefined) {
    applyEndKey(sel, deps);

    return;
  }

  applyActionKey(buf, deps);
}

// `X` asks before it sends anything, and a pinned session has to be unpinned first.
function applyEndKey(sel: MirrorSession, deps: OverlayKeyDeps) {
  const owner = pickPinTarget(sel, deps.mirror.sessions);

  if (sel.pinned || owner.pinned) {
    deps.overlay.notice = `unpin ${owner.pinned ? owner.name : sel.name} first`;
  } else {
    deps.service.send({ type: 'CONFIRM_END', key: toSessionKey(sel) });
  }

  deps.overlay.render();
}

// the keys that act on the session or the daemon without changing the list
function applyActionKey(buf: Buffer, deps: OverlayKeyDeps) {
  const sel = deps.overlay.syncSelection()[deps.overlay.selected];
  const ch = buf.toString();

  if (ch === 'n') {
    deps.service.send({ type: 'SPAWN', resume: false });

    return;
  }

  if (ch === '?') {
    deps.service.send({ type: 'HELP' });

    return;
  }

  if (ch === 'u' && deps.getBoot().stale) {
    void deps.restartDaemonOnce();

    return;
  }

  if (ch === 'H' && sel !== undefined && sel.kind === 'pty' && sel.alive && sel.canEject) {
    deps.service.send({ type: 'EJECT', key: toSessionKey(sel) });

    return;
  }

  if (ch === 'H') {
    deps.logClientEvent('ignored H on a session that cannot eject');

    return;
  }

  if (ch === 'P' && sel !== undefined && sel.resumable && (sel.kind === 'headless' || !sel.alive)) {
    void deps.actions.adoptSession(toSessionKey(sel));

    return;
  }

  if (ch === 'r') {
    deps.service.send({ type: 'SPAWN', resume: true });

    return;
  }

  if ((ch === 'y' || ch === 'Y') && sel !== undefined) {
    void deps.actions.yankResume(toSessionKey(sel), ch === 'Y');

    return;
  }

  if (ch === 'q' || buf[0] === KEY.ctrlC) {
    deps.quit();
  }
}
