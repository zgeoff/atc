import { formatError } from '@atc/core';
import type { DaemonClient } from '@atc/protocol/client';
import { DaemonError } from '@atc/protocol/wire';
import { match } from 'ts-pattern';
import type { ClientActor, ClientMode } from './build-client-machine';
import type { FleetMirror } from './create-fleet-mirror';
import type { OverlayScreen } from './create-overlay-screen';
import { pickForgetStep } from './pick-forget-step';
import { cols } from './ui';

// What the actions borrow from the client that owns the screen, the fleet
// mirror, and the daemon connection.
export interface SessionActionsDeps {
  readonly service: ClientActor;
  readonly mirror: FleetMirror;
  readonly overlay: Pick<OverlayScreen, 'notice' | 'render'>;
  readonly getClient: () => Pick<DaemonClient, 'sendRequest'>;
  readonly getMode: () => ClientMode;
  readonly attach: (sessionID: string) => Promise<void>;
  readonly sendQuiet: (method: string, params?: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly ptyRows: () => number;
}

// The requests the overlay makes on one session, which never throw.
export interface SessionActions {
  // A kill the daemon refuses because forgetting the session destroys its
  // host asks once more before the forget.
  readonly sendKill: (sessionID: string) => Promise<void>;

  // Forgets a session that has exited. A forget that destroys the session's
  // host asks once more instead. The hint line shows why the forget kept the
  // session's workspace, or why the daemon refused it.
  readonly sendForget: (sessionID: string) => Promise<void>;

  // Takes the confirm token the daemon offers and hands it straight back:
  // the operator already confirmed in the overlay.
  readonly sendDestroy: (sessionID: string) => Promise<void>;

  readonly adoptSession: (id: string) => Promise<void>;

  // A failed overlay action lands in the session's message column, so the
  // reason is visible instead of the action silently doing nothing.
  readonly recordActionFailure: (id: string, error: unknown) => void;

  readonly yankResume: (sessionID: string, eject: boolean) => Promise<void>;
}

export function createSessionActions(deps: SessionActionsDeps): SessionActions {
  const recordActionFailure = (id: string, error: unknown) => {
    const session = deps.mirror.sessions.find((x) => x.id === id);

    if (session !== undefined) {
      session.lastMsg = formatError(error);
    }
  };

  const renderOverlay = () => {
    if (deps.getMode() === 'overlay') {
      deps.overlay.render();
    }
  };

  // The forgotten row leaves the list at once, so the notice goes on the
  // hint line instead of the row's message column.
  const showNotice = (notice: string) => {
    deps.overlay.notice = notice;

    renderOverlay();
  };

  const applyForgetAnswer = (sessionID: string, answer: Readonly<Record<string, unknown>>) => {
    match(pickForgetStep(answer))
      .with({ step: 'confirm' }, () => {
        deps.service.send({ type: 'CONFIRM_DESTROY', sessionID });

        renderOverlay();
      })
      .with({ step: 'notice' }, (step) => {
        showNotice(step.notice);
      })
      .with({ step: 'none' }, () => {})
      .exhaustive();
  };

  return {
    sendKill: async (sessionID) => {
      try {
        await deps.getClient().sendRequest('session.kill', { session: sessionID });
      } catch (error) {
        if (error instanceof DaemonError && error.code === 'confirmation_required') {
          deps.service.send({ type: 'CONFIRM_DESTROY', sessionID });

          if (deps.getMode() === 'overlay') {
            deps.overlay.render();
          }
        }
      }
    },

    sendForget: async (sessionID) => {
      try {
        const answer = await deps
          .getClient()
          .sendRequest('session.forget', { session: sessionID, refuseLive: true });

        applyForgetAnswer(sessionID, answer);
      } catch (error) {
        showNotice(formatError(error));
      }
    },

    sendDestroy: async (sessionID) => {
      try {
        const offered = await deps
          .getClient()
          .sendRequest('session.forget', { session: sessionID, refuseLive: true });

        const confirmToken = offered['confirmToken'];

        const answer =
          typeof confirmToken === 'string'
            ? await deps.getClient().sendRequest('session.forget', {
                session: sessionID,
                confirmToken,
                refuseLive: true,
              })
            : offered;

        applyForgetAnswer(sessionID, answer);
      } catch (error) {
        showNotice(formatError(error));
      }
    },

    adoptSession: async (id) => {
      try {
        await deps
          .getClient()
          .sendRequest('session.adopt', { session: id, cols: cols(), rows: deps.ptyRows() });

        await deps.attach(id);
      } catch (error) {
        recordActionFailure(id, error);

        deps.service.send({ type: 'OVERLAY' });
      }
    },

    recordActionFailure,

    yankResume: async (sessionID, eject) => {
      try {
        const answer = await deps
          .getClient()
          .sendRequest('session.resumeCommand', { session: sessionID });

        const command = answer['command'];

        if (typeof command !== 'string') {
          return;
        }

        copyToClipboard(command);

        const session = deps.mirror.sessions.find((x) => x.id === sessionID);

        if (session !== undefined) {
          session.lastMsg = 'resume cmd copied';
        }

        // Eject hands the session off entirely.
        if (eject) {
          void deps.sendQuiet('session.kill', { session: sessionID });
        }

        if (deps.getMode() === 'overlay') {
          deps.overlay.render();
        }
      } catch (error) {
        // A session the daemon cannot resume outside atc keeps running, and
        // the reason replaces the copy notice.
        recordActionFailure(sessionID, error);

        if (deps.getMode() === 'overlay') {
          deps.overlay.render();
        }
      }
    },
  };
}

// Best-effort clipboard: OSC 52 (works through zellij/tmux/ssh) plus any
// local clipboard helper that exists.
function copyToClipboard(text: string) {
  process.stdout.write(`\u001B]52;c;${Buffer.from(text).toString('base64')}\u0007`);

  for (const cmd of [['clip.exe'], ['wl-copy'], ['xclip', '-selection', 'clipboard']]) {
    try {
      const subprocess = Bun.spawn(cmd, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });

      void subprocess.stdin.write(text);
      void subprocess.stdin.end();
      break;
    } catch {}
  }
}
