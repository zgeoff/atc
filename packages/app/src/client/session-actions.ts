import type { DaemonClient } from '@atc/protocol/client';
import { DaemonError } from '@atc/protocol/wire';
import type { ClientActor, ClientMode } from './build-client-machine';
import type { FleetMirror } from './fleet-mirror';
import type { OverlayScreen } from './overlay-screen';
import { cols } from './ui';

// What the actions borrow from the client that owns the screen, the fleet
// mirror, and the daemon connection.
export interface SessionActionsDeps {
  readonly service: ClientActor;
  readonly mirror: FleetMirror;
  readonly overlay: OverlayScreen;
  readonly getClient: () => DaemonClient;
  readonly getMode: () => ClientMode;
  readonly attach: (sessionID: string) => Promise<void>;
  readonly sendQuiet: (m: string, p?: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly ptyRows: () => number;
}

// The requests the overlay makes on one session, which never throw.
export class SessionActions {
  private readonly deps: SessionActionsDeps;

  constructor(deps: SessionActionsDeps) {
    this.deps = deps;
  }

  // A kill the daemon refuses because forgetting the session destroys its
  // host asks once more before the forget.
  async sendKill(sessionID: string) {
    try {
      await this.deps.getClient().sendRequest('session.kill', { session: sessionID });
    } catch (error) {
      if (error instanceof DaemonError && error.code === 'confirmation_required') {
        this.deps.service.send({ type: 'CONFIRM_DESTROY', sessionID });

        if (this.deps.getMode() === 'overlay') {
          this.deps.overlay.render();
        }
      }
    }
  }

  // Takes the confirm token the daemon offers and hands it straight back:
  // the operator already confirmed in the overlay.
  async sendForget(sessionID: string) {
    try {
      const offered = await this.deps
        .getClient()
        .sendRequest('session.forget', { session: sessionID });

      const confirmToken = offered['confirmToken'];

      if (typeof confirmToken === 'string') {
        await this.deps
          .getClient()
          .sendRequest('session.forget', { session: sessionID, confirmToken });
      }
    } catch {}
  }

  async adoptSession(id: string) {
    try {
      await this.deps
        .getClient()
        .sendRequest('session.adopt', { session: id, cols: cols(), rows: this.deps.ptyRows() });

      await this.deps.attach(id);
    } catch (error) {
      this.recordActionFailure(id, error);
      this.deps.service.send({ type: 'OVERLAY' });
    }
  }

  // A failed overlay action lands in the session's message column, so the
  // reason is visible instead of the action silently doing nothing.
  recordActionFailure(id: string, error: unknown) {
    const s = this.deps.mirror.sessions.find((x) => x.id === id);

    if (s !== undefined) {
      s.lastMsg = error instanceof Error ? error.message : String(error);
    }
  }

  async yankResume(sessionID: string, eject: boolean) {
    try {
      const answer = await this.deps
        .getClient()
        .sendRequest('session.resumeCommand', { session: sessionID });

      const command = answer['command'];

      if (typeof command !== 'string') {
        return;
      }

      copyToClipboard(command);

      const s = this.deps.mirror.sessions.find((x) => x.id === sessionID);

      if (s !== undefined) {
        s.lastMsg = 'resume cmd copied';
      }

      // Eject hands the session off entirely.
      if (eject) {
        void this.deps.sendQuiet('session.kill', { session: sessionID });
      }

      if (this.deps.getMode() === 'overlay') {
        this.deps.overlay.render();
      }
    } catch (error) {
      // A session the daemon cannot resume outside atc keeps running, and
      // the reason replaces the copy notice.
      this.recordActionFailure(sessionID, error);

      if (this.deps.getMode() === 'overlay') {
        this.deps.overlay.render();
      }
    }
  }
}

// Best-effort clipboard: OSC 52 (works through zellij/tmux/ssh) plus any
// local clipboard helper that exists.
function copyToClipboard(text: string) {
  process.stdout.write(`\u001B]52;c;${Buffer.from(text).toString('base64')}\u0007`);

  for (const cmd of [['clip.exe'], ['wl-copy'], ['xclip', '-selection', 'clipboard']]) {
    try {
      const proc = Bun.spawn(cmd, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });

      void proc.stdin.write(text);
      void proc.stdin.end();
      break;
    } catch {}
  }
}
