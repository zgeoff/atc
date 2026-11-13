import { formatError } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import { match } from 'ts-pattern';
import type { ClientActor, ClientMode } from './build-client-machine';
import type { FleetMirror } from './create-fleet-mirror';
import type { OverlayScreen } from './create-overlay-screen';
import { pickForgetStep } from './pick-forget-step';
import { sendToDaemon } from './send-to-daemon';
import type { RequestLinks } from './send-to-daemon';
import type { SessionKey } from './session-key';
import { cols } from './ui';

// What the actions borrow from the client that owns the screen, the fleet
// mirror, and the daemon connection.
export interface SessionActionsDeps {
  readonly service: ClientActor;
  readonly mirror: FleetMirror;
  readonly overlay: Pick<OverlayScreen, 'notice' | 'render'>;
  readonly links: RequestLinks;
  readonly getMode: () => ClientMode;
  readonly attach: (key: SessionKey) => Promise<void>;
  readonly ptyRows: () => number;

  // Tells the status bar why a request on a daemon failed, or that its link is not up.
  readonly reportFailure: (daemon: SessionKey['daemon'], error: unknown) => void;
}

// The requests the overlay makes on one session, which never throw. Each goes to the daemon that
// holds the session, and sends nothing when that daemon's link is not up.
export interface SessionActions {
  // A kill the daemon refuses because forgetting the session destroys its
  // host asks once more before the forget.
  readonly sendKill: (key: SessionKey) => Promise<void>;

  // Forgets a session that has exited. A forget that destroys the session's
  // host asks once more instead. The hint line shows why the forget kept the
  // session's workspace, or why the daemon refused it.
  readonly sendForget: (key: SessionKey) => Promise<void>;

  // Takes the confirm token the daemon offers and hands it straight back:
  // the operator already confirmed in the overlay.
  readonly sendDestroy: (key: SessionKey) => Promise<void>;

  readonly sendAck: (key: SessionKey) => Promise<void>;
  readonly sendPinned: (key: SessionKey, pinned: boolean) => Promise<void>;

  readonly adoptSession: (key: SessionKey) => Promise<void>;

  // A failed overlay action lands in the session's message column, so the
  // reason is visible instead of the action silently doing nothing.
  readonly recordActionFailure: (key: SessionKey, error: unknown) => void;

  readonly yankResume: (key: SessionKey, eject: boolean) => Promise<void>;
}

export function createSessionActions(deps: SessionActionsDeps): SessionActions {
  const send = (
    key: SessionKey,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> =>
    sendToDaemon(deps.links, key.daemon, method, { session: key.id, ...params });

  const recordActionFailure = (key: SessionKey, error: unknown) => {
    const session = deps.mirror.find(key);

    if (session !== undefined) {
      session.lastMsg = formatError(error);
    }

    deps.reportFailure(key.daemon, error);
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

  const applyForgetAnswer = (key: SessionKey, answer: Readonly<Record<string, unknown>>) => {
    match(pickForgetStep(answer))
      .with({ step: 'confirm' }, () => {
        deps.service.send({ type: 'CONFIRM_DESTROY', key });

        renderOverlay();
      })
      .with({ step: 'notice' }, (step) => {
        showNotice(step.notice);
      })
      .with({ step: 'none' }, () => {})
      .exhaustive();
  };

  const killQuietly = async (key: SessionKey) => {
    try {
      await send(key, 'session.kill', {});
    } catch (error) {
      deps.reportFailure(key.daemon, error);
    }
  };

  const reportAndShow = (key: SessionKey, error: unknown) => {
    deps.reportFailure(key.daemon, error);

    showNotice(formatError(error));
  };

  return {
    sendKill: async (key) => {
      try {
        await send(key, 'session.kill', {});
      } catch (error) {
        if (error instanceof DaemonError && error.code === 'confirmation_required') {
          deps.service.send({ type: 'CONFIRM_DESTROY', key });

          renderOverlay();

          return;
        }

        deps.reportFailure(key.daemon, error);
      }
    },

    sendForget: async (key) => {
      try {
        const answer = await send(key, 'session.forget', { refuseLive: true });

        applyForgetAnswer(key, answer);
      } catch (error) {
        reportAndShow(key, error);
      }
    },

    sendDestroy: async (key) => {
      try {
        const offered = await send(key, 'session.forget', { refuseLive: true });

        const confirmToken = offered['confirmToken'];

        const answer =
          typeof confirmToken === 'string'
            ? await send(key, 'session.forget', { confirmToken, refuseLive: true })
            : offered;

        applyForgetAnswer(key, answer);
      } catch (error) {
        reportAndShow(key, error);
      }
    },

    sendAck: async (key) => {
      try {
        await send(key, 'session.ack', {});
      } catch (error) {
        deps.reportFailure(key.daemon, error);
      }
    },

    sendPinned: async (key, pinned) => {
      try {
        await send(key, 'session.update', { pinned });
      } catch (error) {
        deps.reportFailure(key.daemon, error);
      }
    },

    adoptSession: async (key) => {
      try {
        await send(key, 'session.adopt', { cols: cols(), rows: deps.ptyRows() });

        await deps.attach(key);
      } catch (error) {
        recordActionFailure(key, error);

        deps.service.send({ type: 'OVERLAY' });
      }
    },

    recordActionFailure,

    yankResume: async (key, eject) => {
      try {
        const answer = await send(key, 'session.resumeCommand', {});

        const command = answer['command'];

        if (typeof command !== 'string') {
          return;
        }

        copyToClipboard(command);

        const session = deps.mirror.find(key);

        if (session !== undefined) {
          session.lastMsg = 'resume cmd copied';
        }

        // Eject hands the session off entirely.
        if (eject) {
          void killQuietly(key);
        }

        renderOverlay();
      } catch (error) {
        // A session the daemon cannot resume outside atc keeps running, and
        // the reason replaces the copy notice.
        recordActionFailure(key, error);
        renderOverlay();
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
