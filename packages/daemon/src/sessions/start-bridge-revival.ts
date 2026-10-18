import type { Clock, SessionID } from '@atc/core';
import { buildTarArchive } from '@atc/core';
import type { HookEvent } from '@atc/protocol/session';
import type { TapClient } from '../daemon-context';
import type { Session } from './session';
import type { SessionManager } from './sessions';
import type { TapRegistry } from './tap-registry';

interface BridgeRevivalDeps {
  readonly mgr: Pick<SessionManager, 'sessions' | 'findAdapter' | 'requireExecution' | 'log'>;
  readonly taps: Pick<TapRegistry<TapClient>, 'hasTap' | 'subscribeToDetach'>;
  readonly clock: Clock;

  // Whether the session's agent process has ended, though its terminal
  // handle may not have closed yet.
  readonly isProcessEnded: (sessionID: SessionID) => boolean;

  // Lands a note in the session's events.
  readonly applyNote: (e: HookEvent) => Promise<void>;

  // How long a session goes without its tap before the first write, and the
  // longest wait the doubling after each write reaches.
  readonly firstDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface BridgeRevival {
  readonly stop: () => void;
}

const FIRST_DELAY_MS = 30_000;
const MAX_DELAY_MS = 30 * 60_000;

// A running remote session whose tap stays gone gets its bridge mod written
// again, once per loss, which makes Claude Code load a mod it turned off.
// Each write doubles the wait before the next one.
export function startBridgeRevival(deps: BridgeRevivalDeps): BridgeRevival {
  const firstDelayMs = deps.firstDelayMs ?? FIRST_DELAY_MS;
  const maxDelayMs = deps.maxDelayMs ?? MAX_DELAY_MS;

  const pending = new Map<SessionID, () => void>();
  const delays = new Map<SessionID, number>();

  let isStopped = false;

  const scheduleCheck = (sessionID: SessionID) => {
    if (isStopped) {
      return;
    }

    // the wait runs from the latest loss, so a tap that left and came back
    // earlier never shortens it
    pending.get(sessionID)?.();

    const cancel = deps.clock.schedule(
      () => {
        pending.delete(sessionID);
        void writeBridgeAgain(sessionID);
      },
      delays.get(sessionID) ?? firstDelayMs,
    );

    pending.set(sessionID, cancel);
  };

  const writeBridgeAgain = async (sessionID: SessionID) => {
    const s = deps.mgr.sessions.find((x) => x.id === sessionID);

    if (s === undefined) {
      delays.delete(sessionID);

      return;
    }

    if (
      isStopped ||
      deps.taps.hasTap(sessionID) ||
      s.pty === null ||
      s.suspended ||
      deps.isProcessEnded(sessionID)
    ) {
      return;
    }

    try {
      await transferBridge(s);
    } catch (error) {
      deps.mgr.log(
        `session ${sessionID}: writing its atc-bridge mod again failed: ${String(error)}`,
      );
    }
  };

  const transferBridge = async (s: Session) => {
    const adapter = deps.mgr.findAdapter(s.agent);
    const provider = deps.mgr.requireExecution(s, 'transfer').provider;

    if (
      adapter?.planGuestBridgeFiles === undefined ||
      !provider.remote ||
      provider.guest?.atc === undefined ||
      provider.guest.atc === null
    ) {
      return;
    }

    const files = Object.entries(adapter.planGuestBridgeFiles(provider.guest.atc)).map(
      ([path, content]) => ({ path, content }),
    );

    delays.set(s.id, Math.min((delays.get(s.id) ?? firstDelayMs) * 2, maxDelayMs));

    await provider.transferArchive(
      buildTarArchive(files),
      `${provider.guest.dir}/sessions/${s.id}`,
      s.hostKey,
    );

    deps.mgr.log(`session ${s.id}: its atc-bridge tap was gone, so atc wrote the mod again`);

    await deps.applyNote({
      atcId: s.id,
      event: 'Note',
      payload: {
        kind: 'note',
        label: 'progress',
        text: 'atc: this session lost its atc-bridge tap, so its note and answer tools may be gone. atc wrote the bridge mod again, which makes Claude Code load it once more.',
      },
    });
  };

  const unsubscribe = deps.taps.subscribeToDetach((sessionID) => {
    scheduleCheck(sessionID);
  });

  return {
    stop: () => {
      isStopped = true;

      unsubscribe();

      for (const cancel of pending.values()) {
        cancel();
      }

      pending.clear();
    },
  };
}
