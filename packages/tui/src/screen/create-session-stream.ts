import type { SessionEmulator } from '../emulator/create-session-emulator';
import type { DaemonName, SessionKey } from '../fleet/session-key';
import { isSameSessionKey } from '../fleet/session-key';

export interface SessionStreamDeps {
  readonly createEmulator: (cols: number, rows: number) => SessionEmulator;

  // the session answered a query of the agent's, through the TUI's emulator
  readonly onReply: (key: SessionKey, bytes: string) => void;
  readonly onPassthrough: (sequence: string) => void;

  // the emulator holds something new to draw
  readonly onChange: () => void;
}

type SessionStreamEvent =
  | {
      readonly ev: 'SessionOutput';
      readonly sessionID: string;
      readonly seq: number;
      readonly data: string;
    }
  | {
      readonly ev: 'SessionReplay';
      readonly sessionID: string;
      readonly seq: number;
      readonly data: string;
      readonly done: boolean;
    }
  | { readonly ev: 'SessionDesync'; readonly sessionID: string }
  | {
      readonly ev: 'SessionResized';
      readonly sessionID: string;
      readonly cols: number;
      readonly rows: number;
    };

interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export interface SessionStream {
  // starts a fresh emulator for the session the TUI attaches to; `full` expects SessionReplay
  // events, and `screen` expects the daemon's repaint as ordinary output
  readonly begin: (key: SessionKey, replay: 'screen' | 'full', size: TerminalSize) => void;
  readonly end: () => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly readEmulator: () => SessionEmulator | null;

  // false while a replay is arriving or the emulator still parses output, when its screen would
  // show half a state
  readonly isSettled: () => boolean;
  readonly applyEvent: (daemon: DaemonName, event: SessionStreamEvent) => void;
}

interface Active {
  readonly key: SessionKey;
  readonly emulator: SessionEmulator;
  readonly replay: 'screen' | 'full';

  // full replay only: output at or below this seq is already in the replay
  phase: 'waiting' | 'replaying' | 'live';
  replaySeq: number;
  pendingWrites: number;
}

export function createSessionStream(deps: SessionStreamDeps): SessionStream {
  let active: Active | null = null;

  const findActive = (daemon: DaemonName, sessionID: string): Active | null => {
    if (active === null || !isSameSessionKey(active.key, { daemon, id: sessionID })) {
      return null;
    }

    return active;
  };

  return {
    begin: (key, replay, size) => {
      active?.emulator.dispose();
      const emulator = deps.createEmulator(size.cols, size.rows);

      emulator.onReply((bytes) => {
        deps.onReply(key, bytes);
      });

      emulator.onPassthrough(deps.onPassthrough);

      active = {
        key,
        emulator,
        replay,
        phase: replay === 'full' ? 'waiting' : 'live',
        replaySeq: 0,
        pendingWrites: 0,
      };

      deps.onChange();
    },

    end: () => {
      active?.emulator.dispose();
      active = null;

      deps.onChange();
    },

    resize: (cols, rows) => {
      active?.emulator.resize(cols, rows);
      deps.onChange();
    },

    readEmulator: () => active?.emulator ?? null,

    isSettled: () =>
      active === null || (active.pendingWrites === 0 && active.phase !== 'replaying'),

    applyEvent: (daemon, event) => {
      const target = findActive(daemon, event.sessionID);

      if (target === null) {
        return;
      }

      if (event.ev === 'SessionResized') {
        target.emulator.resize(event.cols, event.rows);
        deps.onChange();
      } else if (event.ev === 'SessionDesync') {
        applyDesync(target);
      } else if (event.ev === 'SessionReplay') {
        void applyReplay(target, event, deps.onChange);
      } else {
        void applyOutput(target, event, deps.onChange);
      }
    },
  };
}

// After a desync the daemon drops the client's output until its fresh replay, so the output
// that follows the event is stale.
function applyDesync(target: Active): void {
  if (target.replay === 'full') {
    target.phase = 'waiting';
  }
}

async function applyReplay(
  target: Active,
  event: Extract<SessionStreamEvent, { ev: 'SessionReplay' }>,
  onChange: () => void,
): Promise<void> {
  if (target.phase !== 'replaying') {
    void target.emulator.reset();
    target.phase = 'replaying';
  }

  const written = writeTracked(target, event.data);

  if (event.done) {
    target.phase = 'live';
    target.replaySeq = event.seq;

    await written;

    onChange();
  }
}

async function writeTracked(target: Active, data: string): Promise<void> {
  target.pendingWrites += 1;

  try {
    await target.emulator.write(data);
  } finally {
    target.pendingWrites -= 1;
  }
}

async function applyOutput(
  target: Active,
  event: Extract<SessionStreamEvent, { ev: 'SessionOutput' }>,
  onChange: () => void,
): Promise<void> {
  if (target.replay === 'full' && (target.phase !== 'live' || event.seq <= target.replaySeq)) {
    return;
  }

  await writeTracked(target, event.data);

  onChange();
}
