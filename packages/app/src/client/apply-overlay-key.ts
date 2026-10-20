import { ansi } from '@atc/core';
import type { DaemonBoot } from '@atc/protocol';
import type { ClientActor } from './build-client-machine';
import type { FleetMirror } from './fleet-mirror';
import { KEY, isDown, isUp } from './keys';
import type { OverlayConfirm, OverlayScreen } from './overlay-screen';
import { pickPinTarget } from './pick-pin-target';
import { pickTabTarget } from './pick-tab-target';
import type { SessionActions } from './session-actions';

// What the overlay's keys borrow from the client that owns the screen, the
// fleet mirror, and the daemon connection.
export interface OverlayKeyDeps {
  readonly service: ClientActor;
  readonly mirror: FleetMirror;
  readonly overlay: OverlayScreen;
  readonly actions: SessionActions;
  readonly getConfirm: () => OverlayConfirm;
  readonly getBoot: () => DaemonBoot;
  readonly isLeaderKey: (buf: Buffer) => boolean;
  readonly showBase: () => void;
  readonly attach: (sessionID: string) => Promise<void>;
  readonly sendQuiet: (method: string, params?: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly restartDaemonOnce: () => Promise<void>;
  readonly logClientEvent: (line: string) => void;
  readonly quit: () => void;
}

export function applyOverlayKey(buf: Buffer, deps: OverlayKeyDeps) {
  const filtered = deps.overlay.pickSessions();
  const sel = filtered[deps.overlay.selected];
  const confirm = deps.getConfirm();

  if (confirm === 'kill') {
    if (buf[0] === KEY.y && sel !== undefined) {
      void deps.actions.sendKill(sel.id);
    }

    deps.service.send({ type: 'CONFIRM_DONE' });
    deps.overlay.render();

    return;
  }

  const destroyID = deps.service.getSnapshot().context.destroyID;

  if (confirm === 'destroy' && destroyID !== null) {
    if (buf[0] === KEY.y) {
      void deps.actions.sendForget(destroyID);
    }

    deps.service.send({ type: 'CONFIRM_DONE' });
    deps.overlay.render();

    return;
  }

  if (applyOverlayFilterKey(buf, deps)) {
    return;
  }

  if (buf.toString() === '/') {
    deps.overlay.filter = '';
    deps.overlay.selected = 0;

    process.stdout.write(ansi.clear);
    deps.overlay.render();

    return;
  }

  if (deps.isLeaderKey(buf) || (buf[0] === KEY.esc && buf.length === 1)) {
    deps.showBase();

    return;
  }

  if (isDown(buf) || buf.toString() === 'j') {
    deps.overlay.selected = Math.min(filtered.length - 1, deps.overlay.selected + 1);

    deps.overlay.render();

    return;
  }

  if (isUp(buf) || buf.toString() === 'k') {
    deps.overlay.selected = Math.max(0, deps.overlay.selected - 1);

    deps.overlay.render();

    return;
  }

  const ch = buf.toString();

  if (buf[0] === KEY.tab) {
    const target = pickTabTarget(deps.mirror.sessions, (id) => deps.mirror.doneAt.get(id));

    if (target !== undefined) {
      void deps.attach(target.id);
    }

    return;
  }

  if (buf[0] === KEY.enter && sel !== undefined && sel.alive) {
    void deps.attach(sel.id);

    return;
  }

  if (ch === 'a' && sel !== undefined) {
    void deps.sendQuiet('session.ack', { session: sel.id });
    deps.overlay.render();

    return;
  }

  if (ch === 'n') {
    deps.service.send({ type: 'SPAWN', resume: false });

    return;
  }

  if (ch === 'g') {
    deps.overlay.grouped = !deps.overlay.grouped;

    process.stdout.write(ansi.clear);
    deps.overlay.render();

    return;
  }

  if (ch === 'p' && sel !== undefined) {
    // Flipped locally too so the repaint is immediate; the daemon's state
    // event confirms it.
    const target = pickPinTarget(sel, deps.mirror.sessions);

    target.pinned = !target.pinned;
    void deps.sendQuiet('session.update', { session: target.id, pinned: target.pinned });
    deps.overlay.render();

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
    deps.service.send({ type: 'EJECT', sessionID: sel.id });

    return;
  }

  if (ch === 'H') {
    deps.logClientEvent('ignored H on a session that cannot eject');

    return;
  }

  if (ch === 'P' && sel !== undefined && sel.resumable && (sel.kind === 'headless' || !sel.alive)) {
    void deps.actions.adoptSession(sel.id);

    return;
  }

  if (ch === 'r') {
    deps.service.send({ type: 'SPAWN', resume: true });

    return;
  }

  if ((ch === 'y' || ch === 'Y') && sel !== undefined) {
    void deps.actions.yankResume(sel.id, ch === 'Y');

    return;
  }

  if (ch === 'K' && sel !== undefined) {
    deps.service.send({ type: 'CONFIRM_KILL' });
    deps.overlay.render();

    return;
  }

  if (ch === 'q' || buf[0] === KEY.ctrlC) {
    deps.quit();
  }
}

function applyOverlayFilterKey(buf: Buffer, deps: OverlayKeyDeps): boolean {
  if (deps.overlay.filter === null) {
    return false;
  }

  // esc clears the filter but stays in the overlay; enter falls through to
  // the normal handler so it attaches the selected match.
  if (buf[0] === KEY.esc && buf.length === 1) {
    deps.overlay.filter = null;

    process.stdout.write(ansi.clear);
    deps.overlay.render();

    return true;
  }

  if (buf[0] === KEY.backspace) {
    deps.overlay.filter = deps.overlay.filter.slice(0, -1);

    process.stdout.write(ansi.clear);
    deps.overlay.render();

    return true;
  }

  if (buf[0] === KEY.ctrlU) {
    deps.overlay.filter = '';

    process.stdout.write(ansi.clear);
    deps.overlay.render();

    return true;
  }

  if (buf[0] === KEY.enter || isUp(buf) || isDown(buf) || deps.isLeaderKey(buf)) {
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
    deps.overlay.filter += text;

    process.stdout.write(ansi.clear);
    deps.overlay.render();

    return true;
  }

  return true;
}
