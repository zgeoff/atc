import { formatError } from '@atc/core';
import { match } from 'ts-pattern';
import { sendToDaemon } from '../daemon-link/send-to-daemon';
import type { RequestLinks } from '../daemon-link/send-to-daemon';
import type { FleetMirror } from '../fleet/create-fleet-mirror';
import type { SessionKey } from '../fleet/session-key';
import type { OverlayScreen } from '../overlay/create-overlay-screen';
import { pickEndNotice } from '../overlay/pick-end-notice';
import { pickForgetStep } from '../overlay/pick-forget-step';
import { cols } from '../terminal/cols';
import type { ClientActor, ClientMode } from './build-client-machine';

export interface SessionActionsDeps {
  readonly service: ClientActor;
  readonly mirror: FleetMirror;
  readonly overlay: Pick<OverlayScreen, 'notice' | 'render'>;
  readonly links: RequestLinks;
  readonly getMode: () => ClientMode;
  readonly attach: (key: SessionKey) => Promise<void>;
  readonly ptyRows: () => number;

  readonly reportFailure: (daemon: SessionKey['daemon'], error: unknown) => void;
}

export interface SessionActions {
  readonly sendKill: (key: SessionKey) => Promise<void>;

  // Ends a session: stops its agent and removes it from the fleet. The daemon deletes the machine
  // only after a confirm token, which `namesMachine` says the user's question already asked for.
  readonly sendEnd: (key: SessionKey, namesMachine: boolean) => Promise<void>;
  readonly sendPinned: (key: SessionKey, pinned: boolean) => Promise<void>;

  readonly adoptSession: (key: SessionKey) => Promise<void>;

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

  const reportEndFailure = (key: SessionKey, error: unknown) => {
    const name = deps.mirror.find(key)?.name ?? key.id;
    const notice = pickEndNotice(error, name);

    if (notice === null) {
      deps.reportFailure(key.daemon, error);
    }

    showNotice(notice ?? formatError(error));
  };

  return {
    sendKill: async (key) => {
      try {
        await send(key, 'session.kill', {});
      } catch (error) {
        deps.reportFailure(key.daemon, error);
      }
    },

    sendEnd: async (key, namesMachine) => {
      try {
        const offered = await send(key, 'session.forget', { refusePinned: true });

        const confirmToken = offered['confirmToken'];

        if (typeof confirmToken !== 'string') {
          applyForgetAnswer(key, offered);

          return;
        }

        if (!namesMachine) {
          deps.service.send({ type: 'CONFIRM_DESTROY', key });

          renderOverlay();

          return;
        }

        const answer = await send(key, 'session.forget', { confirmToken, refusePinned: true });

        applyForgetAnswer(key, answer);
      } catch (error) {
        reportEndFailure(key, error);
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

        if (eject) {
          void killQuietly(key);
        }

        renderOverlay();
      } catch (error) {
        recordActionFailure(key, error);
        renderOverlay();
      }
    },
  };
}

// OSC 52 works through zellij/tmux/ssh.
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
