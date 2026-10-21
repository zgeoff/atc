import type { AgentID, Clock } from '@atc/core';
import type { DaemonBoot, DaemonEvent } from '@atc/protocol';
import type { DaemonClient } from '@atc/protocol/client';
import { DaemonError } from '@atc/protocol/wire';
import { DaemonTransport } from '@atc/protocol/wire/transport';
import type { ClientActor, ClientMode } from './build-client-machine';
import type { FleetMirror } from './fleet-mirror';
import type { OverlayScreen } from './overlay-screen';
import type { SpawnPicker } from './picker/create-spawn-picker';
import type { TUIHost } from './tui-host';
import { cols } from './ui';
import { waitForRestartConsent } from './wait-for-restart-consent';

// What the connection borrows from the client that owns the screen and the
// fleet mirror.
export interface DaemonConnectionDeps {
  readonly clock: Clock;
  readonly bootDaemonClient: TUIHost['bootDaemon'];
  readonly remoteDaemonName: string | null;
  readonly service: ClientActor;
  readonly mirror: FleetMirror;
  readonly overlay: OverlayScreen;
  readonly picker: SpawnPicker;
  readonly getMode: () => ClientMode;
  readonly isDaemonRestarting: () => boolean;
  readonly scheduleStatus: () => void;
  readonly drawMode: () => void;
  readonly sendQuiet: (method: string, params?: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly ptyRows: () => number;
  readonly quit: (code: number, message: string) => never;
  readonly logClientEvent: (line: string) => void;
  readonly onEvent: (raw: DaemonEvent) => void;
  readonly setLastUsedAgent: (agent: AgentID) => void;
}

// What one open of the daemon gave the client: its boot, and whether the
// user restarted a daemon on another protocol to get it, so the fleet that
// daemon hosted is restored on the new one.
interface DaemonLink {
  readonly boot: DaemonBoot;
  readonly restarted: boolean;
}

// The client's link to its daemon: the transport that opens it, reconnects
// it, and brings the mirror up to date on each new connection.
export class DaemonConnection {
  readonly transport: DaemonTransport<DaemonLink>;

  private readonly deps: DaemonConnectionDeps;

  constructor(deps: DaemonConnectionDeps) {
    this.deps = deps;

    this.transport = new DaemonTransport<DaemonLink>({
      reconnect: 'always',
      backoffMs: [0, 200, 1000, 2000],
      clock: deps.clock,
      getChannel: (link) => link.boot.client,
      open: (opened) => {
        const phase = opened === 0 ? 'boot' : 'tui';

        return this.openDaemonLink(phase);
      },

      // the boot's own failure ends the client, and so does a daemon on another protocol the
      // user keeps, or a remote daemon, whose boot already waits out an unreachable one.
      isFatal: (error) =>
        this.transport.findLatest() === null ||
        (error instanceof DaemonError && error.code === 'protocol_mismatch') ||
        deps.remoteDaemonName !== null,
      onReady: (link) => {
        deps.setLastUsedAgent(link.boot.lastUsedAgent);

        link.boot.client.onEvent = deps.onEvent;

        deps.service.send({ type: 'DAEMON_READY' });
        deps.scheduleStatus();
      },
      onLost: () => {
        // The reconnect leaves the picker, so no answer its flow still waits on
        // draws it again. A deliberate restart keeps the screen it drew.
        deps.service.send({ type: 'DAEMON_LOST' });

        if (!deps.isDaemonRestarting()) {
          deps.picker.stopFlow();
          deps.service.send({ type: 'OVERLAY' });
        }

        deps.scheduleStatus();
      },
      onOpenFailed: (error, fatal) => {
        const message = error instanceof Error ? error.message : String(error);

        if (fatal && this.transport.findLatest() !== null) {
          deps.quit(1, `atc: ${message}`);
        }

        if (!deps.isDaemonRestarting()) {
          deps.logClientEvent(`reconnect: ${message}; trying again`);
        }

        deps.scheduleStatus();
      },
    });
  }

  // The client of the latest connection. A request on one that was lost
  // rejects at once, as the reconnect takes its place.
  getClient(): DaemonClient {
    const link = this.transport.findLatest();

    if (link === null) {
      throw new Error('the client has no daemon connection yet');
    }

    return link.boot.client;
  }

  // The boot of the latest connection: the daemon's socket, which a restart
  // takes it out of service by, and its build.
  getBoot(): DaemonBoot {
    const link = this.transport.findLatest();

    if (link === null) {
      throw new Error('the client has no daemon connection yet');
    }

    return link.boot;
  }

  // Opens and handshakes the daemon. A daemon on another protocol is
  // restarted only when the user confirms it: on the first open the prompt
  // goes to stderr, and once the TUI owns the screen it replaces the screen.
  private async openDaemonLink(phase: 'boot' | 'tui'): Promise<DaemonLink> {
    const deps = this.deps;
    let restarted = false;

    const boot = await deps.bootDaemonClient({
      clock: deps.clock,
      ...(phase === 'tui' ? { onWaitForDaemon: deps.scheduleStatus } : {}),
      onProtocolMismatch: async (mismatch) => {
        restarted = await waitForRestartConsent(mismatch, phase, {
          service: deps.service,
          drawMode: deps.drawMode,
        });

        return restarted;
      },
    });

    // A stale answer means the old daemon still holds the socket, so the
    // open is refused and the next one boots again.
    if (boot.stale && deps.clock.now() < deps.service.getSnapshot().context.freshUntil) {
      boot.client.stop();
      throw new Error('the old daemon still answers');
    }

    if (phase === 'tui') {
      void this.refreshAfterReconnect(restarted, () => boot.client.isClosed());
    }

    return { boot, restarted };
  }

  // Brings the mirror up to date on a daemon the client reconnected to. A
  // connection lost on the way is left to the next reconnect, which runs
  // this again.
  private async refreshAfterReconnect(restarted: boolean, isClosed: () => boolean) {
    const deps = this.deps;

    await this.transport.waitForConnection();

    try {
      if (restarted) {
        await deps.sendQuiet('fleet.restore', { cols: cols(), rows: deps.ptyRows() });
      }

      await deps.mirror.refresh(() => this.getClient());
      await deps.overlay.refreshAgents();
    } catch (error) {
      if (!isClosed()) {
        deps.logClientEvent(`reconnect: ${error instanceof Error ? error.message : String(error)}`);
      }

      return;
    }

    if (deps.getMode() === 'overlay') {
      deps.overlay.render();
    }
  }
}
