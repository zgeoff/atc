import { match } from 'ts-pattern';
import type { SessionKey } from '../fleet/session-key';
import { applyOverlayKey } from '../overlay/apply-overlay-key';
import type { OverlayKeyDeps } from '../overlay/apply-overlay-key';
import type { EjectScreen } from '../overlay/create-eject-screen';
import type { SpawnPicker } from '../picker/create-spawn-picker';
import { KEY } from '../terminal/key';
import { splitKeys } from '../terminal/split-keys';
import type { ClientMode, RestartConsent } from './build-client-machine';

export interface InputKeyDeps extends OverlayKeyDeps {
  readonly picker: Pick<SpawnPicker, 'applyKey'>;
  readonly eject: Pick<EjectScreen, 'applyKey'>;
  readonly stdinDecoder: TextDecoder;
  readonly getMode: () => ClientMode;
  readonly findFocusedKey: () => SessionKey | null;
  readonly sendInput: (key: SessionKey, data: string) => Promise<void>;
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

  // A chunk can hold several keys typed fast, and a key can change the mode the next one meets.
  let keys: readonly Buffer[] = splitKeys(buf);

  while (keys.length > 0) {
    keys = applyModeKeys(keys, deps);
  }
}

// Applies the keys the current mode takes from the front of `keys`, and returns the rest.
function applyModeKeys(keys: readonly Buffer[], deps: InputKeyDeps): readonly Buffer[] {
  const [first, ...rest] = keys;

  if (first === undefined) {
    return [];
  }

  return match(deps.getMode())
    .with('attached', () => applyAttachedKeys(keys, deps))
    .with('home', () => {
      applyHomeKey(first, deps);

      return rest;
    })
    .with('overlay', () => {
      applyOverlayKey(first, deps);

      return rest;
    })
    .with('help', () => {
      applyHelpKey(first, deps);

      return rest;
    })
    .with('picker', () => {
      deps.picker.applyKey(Buffer.concat(keys));

      return [];
    })
    .with('picker-eject', () => {
      deps.eject.applyKey(Buffer.concat(keys));

      return [];
    })
    .exhaustive();
}

// The session takes every key before the leader, and the list the keys after it.
function applyAttachedKeys(keys: readonly Buffer[], deps: InputKeyDeps): readonly Buffer[] {
  const leaderIndex = findLeaderIndex(keys, deps);
  const sessionKeys = leaderIndex === null ? keys : keys.slice(0, leaderIndex);
  const focused = deps.findFocusedKey();

  if (focused !== null && sessionKeys.length > 0) {
    void deps.sendInput(
      focused,
      deps.stdinDecoder.decode(Buffer.concat(sessionKeys), { stream: true }),
    );
  }

  if (leaderIndex === null) {
    return [];
  }

  deps.service.send({ type: 'OVERLAY' });

  return keys.slice(leaderIndex + 1);
}

const PASTE_OPEN = '\u001B[200~';
const PASTE_CLOSE = '\u001B[201~';

// A leader byte inside a paste is text for the session.
function findLeaderIndex(keys: readonly Buffer[], deps: InputKeyDeps): number | null {
  let isInPaste = false;

  for (const [index, key] of keys.entries()) {
    const text = key.toString();

    if (text === PASTE_OPEN || text === PASTE_CLOSE) {
      isInPaste = text === PASTE_OPEN;
    } else if (!isInPaste && deps.isLeaderKey(key)) {
      return index;
    }
  }

  return null;
}

function applyHomeKey(buf: Buffer, deps: InputKeyDeps) {
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
}

function applyHelpKey(buf: Buffer, deps: InputKeyDeps) {
  const ch = buf.toString();

  if (buf[0] === KEY.esc || ch === '?' || ch === 'q' || deps.isLeaderKey(buf)) {
    deps.service.send({ type: 'OVERLAY' });
  }
}
