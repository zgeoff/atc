import type { Clock, SessionID } from '@atc/core';
import { buildTarArchive } from '@atc/core';
import type { ExecutionProvider } from '@atc/plugin-api';
import type { HookEvent } from '@atc/protocol/session';
import { createActor } from 'xstate';
import type { Actor } from 'xstate';
import type { TapClient } from '../daemon-context';
import { BRIDGE_REVIVAL_MACHINE } from './bridge-revival-machine';
import type { Session } from './session';
import type { SessionManager } from './sessions';
import type { TapRegistry } from './tap-registry';

interface BridgeRevivalDeps {
  readonly manager: Pick<SessionManager, 'sessions' | 'findAdapter' | 'requireExecution' | 'log'>;
  readonly taps: Pick<TapRegistry<TapClient>, 'hasTap' | 'subscribeToDetach'>;
  readonly clock: Clock;

  // Whether the session's agent process has ended, though its terminal
  // handle may not have closed yet.
  readonly isProcessEnded: (sessionID: SessionID) => boolean;

  // Lands a note in the session's events.
  readonly applyNote: (hookEvent: HookEvent) => Promise<void>;
}

export interface BridgeRevival {
  readonly stop: () => void;
}

// What a write of a session's bridge files needs, once its checks pass.
interface BridgeWrite {
  readonly session: Session;
  readonly provider: ExecutionProvider;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly directory: string;
}

// A running remote session whose tap stays gone gets its bridge mod written
// again, once per loss, which makes Claude Code load a mod it turned off.
// Each session's machine holds its state, and its timers run on the clock.
export function startBridgeRevival(deps: BridgeRevivalDeps): BridgeRevival {
  const actors = new Map<SessionID, Actor<typeof BRIDGE_REVIVAL_MACHINE>>();

  // xstate's clock takes a timer id, and the daemon's clock hands back a cancel
  const cancels = new Map<number, () => void>();

  let nextTimerID = 0;

  const clock = {
    setTimeout: (fn: () => void, timeout: number) => {
      const timerID = nextTimerID++;

      cancels.set(
        timerID,
        deps.clock.schedule(() => {
          cancels.delete(timerID);

          fn();
        }, timeout),
      );

      return timerID;
    },
    clearTimeout: (timerID: number) => {
      cancels.get(timerID)?.();
      cancels.delete(timerID);
    },
  };

  const findSession = (sessionID: SessionID) =>
    deps.manager.sessions.find((x) => x.id === sessionID);

  // Creates, stores and starts the machine of a session that has none.
  const startSessionActor = (sessionID: SessionID) => {
    const machine = BRIDGE_REVIVAL_MACHINE.provide({
      guards: {
        isGone: () => {
          const session = findSession(sessionID);

          // a sleeping host has no terminal, yet its session is not gone
          return (
            session === undefined ||
            deps.isProcessEnded(sessionID) ||
            (session.pty === null && !session.suspended)
          );
        },
        hasTap: () => deps.taps.hasTap(sessionID),
        isAsleep: () => findSession(sessionID)?.suspended === true,
        canWrite: () => findBridgeWrite(sessionID) !== null,
      },
      actions: {
        writeBridge: () => {
          void writeBridge(sessionID);
        },
      },
    });

    const actor = createActor(machine, { clock });

    // a session that left the fleet or whose agent ended keeps no machine
    actor.subscribe({
      complete: () => {
        actors.delete(sessionID);
      },
    });

    actors.set(sessionID, actor);
    actor.start();

    return actor;
  };

  const findBridgeWrite = (sessionID: SessionID): BridgeWrite | null => {
    const session = findSession(sessionID);

    if (session === undefined) {
      return null;
    }

    const adapter = deps.manager.findAdapter(session.agent);
    const provider = findTransferProvider(session);
    const guest = provider?.guest;

    if (
      adapter?.planGuestBridgeFiles === undefined ||
      provider === null ||
      !provider.remote ||
      guest === undefined ||
      guest.atc === null
    ) {
      return null;
    }

    const files = Object.entries(adapter.planGuestBridgeFiles(guest.atc)).map(
      ([path, content]) => ({ path, content }),
    );

    return { session, provider, files, directory: `${guest.directory}/sessions/${session.id}` };
  };

  // A target that refuses transfers, or that left the config, takes no write.
  const findTransferProvider = (session: Session): ExecutionProvider | null => {
    try {
      return deps.manager.requireExecution(session, 'transfer').provider;
    } catch {
      return null;
    }
  };

  const writeBridge = async (sessionID: SessionID) => {
    try {
      const write = findBridgeWrite(sessionID);

      if (write !== null) {
        await transferBridge(write);
      }
    } catch (error) {
      deps.manager.log(
        `session ${sessionID}: writing its atc-bridge mod again failed: ${String(error)}`,
      );
    }

    actors.get(sessionID)?.send({ type: 'WRITE_ENDED' });
  };

  const transferBridge = async (write: BridgeWrite) => {
    const session = write.session;

    await write.provider.transferArchive(
      buildTarArchive(write.files),
      write.directory,
      session.hostKey,
    );

    deps.manager.log(
      `session ${session.id}: its atc-bridge tap was gone, so atc wrote the mod again`,
    );

    await deps.applyNote({
      atcId: session.id,
      event: 'Note',
      payload: {
        kind: 'note',
        label: 'progress',
        text: 'atc: this session lost its atc-bridge tap, so its note and answer tools may be gone. atc wrote the bridge mod again, which makes Claude Code load it once more.',
      },
    });
  };

  const unsubscribe = deps.taps.subscribeToDetach((sessionID) => {
    const actor = actors.get(sessionID) ?? startSessionActor(sessionID);

    actor.send({ type: 'TAP_LEFT' });
  });

  return {
    stop: () => {
      unsubscribe();

      for (const actor of actors.values()) {
        actor.stop();
      }

      actors.clear();
    },
  };
}
