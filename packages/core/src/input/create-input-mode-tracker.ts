export interface InputModes {
  readonly mouse: 'off' | 'click' | 'drag' | 'any';
  readonly mouseEncoding: 'default' | 'sgr' | 'urxvt';
  readonly alternateScroll: boolean;
  readonly bracketedPaste: boolean;
  readonly focusEvents: boolean;
  readonly applicationCursorKeys: boolean;
  readonly applicationKeypad: boolean;
  readonly kittyStack: readonly number[];
  readonly modifyOtherKeys: 0 | 1 | 2;
  readonly colourSchemeUpdates: boolean;
}

export const NO_INPUT_MODES: InputModes = {
  mouse: 'off',
  mouseEncoding: 'default',
  alternateScroll: false,
  bracketedPaste: false,
  focusEvents: false,
  applicationCursorKeys: false,
  applicationKeypad: false,
  kittyStack: [],
  modifyOtherKeys: 0,
  colourSchemeUpdates: false,
};

export interface InputModeTracker {
  readonly write: (data: string) => void;
  readonly read: () => InputModes;
  readonly reset: () => void;
}

export function createInputModeTracker(): InputModeTracker {
  const state = buildInitialState();

  return {
    write: (data) => {
      for (const char of data) {
        advanceParser(state, char);
      }
    },
    read: () => collectInputModes(state),
    reset: () => {
      Object.assign(state, buildInitialState());
    },
  };
}

type ParserState = 'ground' | 'escape' | 'escape-intermediate' | 'csi' | 'string' | 'string-escape';

interface TrackerState {
  parser: ParserState;
  csi: string;
  mouseReporting: Set<number>;
  mouseEncodings: Set<number>;
  flags: Set<number>;
  kittyStack: number[];
  modifyOtherKeys: 0 | 1 | 2;
  applicationKeypad: boolean;
}

function buildInitialState(): TrackerState {
  return {
    parser: 'ground',
    csi: '',
    mouseReporting: new Set(),
    mouseEncodings: new Set(),
    flags: new Set(),
    kittyStack: [],
    modifyOtherKeys: 0,
    applicationKeypad: false,
  };
}

const ESC = '\u001B';
const BEL = '\u0007';

function advanceParser(state: TrackerState, char: string): void {
  if (char === '\u0018' || char === '\u001A') {
    state.parser = 'ground';

    return;
  }

  if (state.parser === 'string') {
    if (char === BEL) {
      state.parser = 'ground';
    } else if (char === ESC) {
      state.parser = 'string-escape';
    }

    return;
  }

  if (state.parser === 'string-escape') {
    // ST ends the string; any other byte after ESC starts a new sequence
    state.parser = 'ground';

    if (char !== '\\') {
      advanceParser(state, char);
    }

    return;
  }

  if (char === ESC) {
    state.parser = 'escape';
    state.csi = '';

    return;
  }

  if (state.parser === 'escape') {
    advanceEscape(state, char);

    return;
  }

  if (state.parser === 'escape-intermediate') {
    if (char >= '0' && char <= '~') {
      state.parser = 'ground';
    }

    return;
  }

  if (state.parser === 'csi') {
    advanceCSI(state, char);
  }
}

function advanceEscape(state: TrackerState, char: string): void {
  state.parser = 'ground';

  if (char === '[') {
    state.parser = 'csi';
    state.csi = '';
  } else if (char === ']' || char === 'P' || char === 'X' || char === '^' || char === '_') {
    state.parser = 'string';
  } else if (char === '=') {
    state.applicationKeypad = true;
  } else if (char === '>') {
    state.applicationKeypad = false;
  } else if (char === 'c') {
    Object.assign(state, buildInitialState());
  } else if (char >= ' ' && char <= '/') {
    state.parser = 'escape-intermediate';
  }
}

function advanceCSI(state: TrackerState, char: string): void {
  if (char >= '@' && char <= '~') {
    state.parser = 'ground';

    applyCSI(state, state.csi, char);

    return;
  }

  if (char >= ' ' && char <= '?') {
    state.csi += char;

    return;
  }

  state.parser = 'ground';
}

function applyCSI(state: TrackerState, body: string, final: string): void {
  const prefix = /^[?<=>]/u.test(body) ? body.slice(0, 1) : '';
  const rest = body.slice(prefix.length);

  if (/[ -/]/u.test(rest)) {
    return;
  }

  const params = rest.split(';').map((part) => {
    const text = part.split(':')[0] ?? '';
    const parsed = Math.trunc(Number(text));

    return text === '' || Number.isNaN(parsed) ? null : parsed;
  });

  if (prefix === '?' && (final === 'h' || final === 'l')) {
    applyPrivateModes(state, params, final === 'h');
  } else if (final === 'u') {
    applyKitty(state, prefix, params);
  } else if (prefix === '>' && final === 'm' && params[0] === 4) {
    const value = params[1] ?? 0;

    state.modifyOtherKeys = value === 1 || value === 2 ? value : 0;
  }
}

function applyPrivateModes(
  state: TrackerState,
  params: readonly (number | null)[],
  isSet: boolean,
): void {
  for (const mode of params) {
    if (mode === null) {
      continue;
    }

    const target = pickModeSet(state, mode);

    if (target === null) {
      continue;
    }

    if (isSet) {
      target.add(mode);
    } else {
      target.delete(mode);
    }
  }
}

const FLAG_MODES = new Set([1, 1007, 1004, 2004, 2031]);
const MOUSE_REPORTING_MODES = new Set([1000, 1002, 1003]);
const MOUSE_ENCODING_MODES = new Set([1006, 1015]);

function pickModeSet(state: TrackerState, mode: number): Set<number> | null {
  if (FLAG_MODES.has(mode)) {
    return state.flags;
  }

  if (MOUSE_REPORTING_MODES.has(mode)) {
    return state.mouseReporting;
  }

  return MOUSE_ENCODING_MODES.has(mode) ? state.mouseEncodings : null;
}

// The terminal drops the oldest entry of a full stack, as kitty's protocol specifies.
const KITTY_STACK_LIMIT = 16;

function applyKitty(state: TrackerState, prefix: string, params: readonly (number | null)[]): void {
  if (prefix === '>') {
    state.kittyStack.push(params[0] ?? 0);

    if (state.kittyStack.length > KITTY_STACK_LIMIT) {
      state.kittyStack.shift();
    }
  } else if (prefix === '<') {
    const count = Math.max(1, params[0] ?? 1);

    state.kittyStack.splice(Math.max(0, state.kittyStack.length - count));
  } else if (prefix === '=') {
    setKittyFlags(state, params[0] ?? 0, params[1] ?? 1);
  }
}

function setKittyFlags(state: TrackerState, flags: number, mode: number): void {
  const current = state.kittyStack.pop() ?? 0;

  if (mode === 2) {
    state.kittyStack.push(current | flags);
  } else if (mode === 3) {
    state.kittyStack.push(current & ~flags);
  } else {
    state.kittyStack.push(flags);
  }
}

function collectInputModes(state: TrackerState): InputModes {
  return {
    mouse: pickMouse(state.mouseReporting),
    mouseEncoding: pickMouseEncoding(state.mouseEncodings),
    alternateScroll: state.flags.has(1007),
    bracketedPaste: state.flags.has(2004),
    focusEvents: state.flags.has(1004),
    applicationCursorKeys: state.flags.has(1),
    applicationKeypad: state.applicationKeypad,
    kittyStack: [...state.kittyStack],
    modifyOtherKeys: state.modifyOtherKeys,
    colourSchemeUpdates: state.flags.has(2031),
  };
}

function pickMouse(reporting: ReadonlySet<number>): InputModes['mouse'] {
  if (reporting.has(1003)) {
    return 'any';
  }

  if (reporting.has(1002)) {
    return 'drag';
  }

  return reporting.has(1000) ? 'click' : 'off';
}

function pickMouseEncoding(encodings: ReadonlySet<number>): InputModes['mouseEncoding'] {
  if (encodings.has(1006)) {
    return 'sgr';
  }

  return encodings.has(1015) ? 'urxvt' : 'default';
}
