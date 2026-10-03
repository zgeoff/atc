import type { HarnessExit, HarnessHandle } from './execution-provider';
import type {
  ImpPort,
  ImpSessionConnection,
  ImpSessionOutcome,
  ImpSessionRequest,
} from './imp-port';

// What the harness asks of the provider that started it.
interface ImpHarnessHost {
  // Whether the provider is putting the harness's host to sleep, so a
  // connection the sleep ends is the sleep's and not the harness's end.
  readonly isSuspending: () => boolean;

  // Called once, when the harness ends or the daemon lets go of it.
  readonly onDone: () => void;
}

/**
 * A harness running in an imp session, as the daemon's one connection to
 * it. Input written before the session starts waits for it. A kill sends
 * the process SIGHUP, as closing a terminal does; a detach closes the
 * connection and leaves the process running under its session name.
 */
export class ImpHarness implements HarnessHandle {
  private readonly port: ImpPort;

  private readonly host: ImpHarnessHost;

  private readonly dataListeners = new Set<(data: string) => void>();

  private readonly exitListeners = new Set<(exit: HarnessExit) => void>();

  private readonly decoder = new TextDecoder();

  private connection: ImpSessionConnection | null = null;

  private started = false;

  private done = false;

  private pending: Uint8Array[] = [];

  constructor(port: ImpPort, start: ImpSessionRequest, host: ImpHarnessHost) {
    this.port = port;
    this.host = host;
    this.connection = this.openConnection(start);
  }

  readonly onData = (listener: (data: string) => void) => {
    this.dataListeners.add(listener);

    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  };

  readonly onExit = (listener: (exit: HarnessExit) => void) => {
    this.exitListeners.add(listener);

    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  };

  readonly write = (data: string): void => {
    const bytes = new TextEncoder().encode(data);

    if (this.started && this.connection !== null) {
      this.connection.write(bytes);
    } else if (!this.done) {
      this.pending.push(bytes);
    }
  };

  readonly resize = (cols: number, rows: number): void => {
    this.connection?.resize(cols, rows);
  };

  readonly kill = (): void => {
    this.connection?.sendSignal('SIGHUP');
  };

  readonly detach = (): void => {
    if (this.done) {
      return;
    }

    this.done = true;

    this.dataListeners.clear();
    this.exitListeners.clear();
    this.connection?.close();
    this.connection = null;

    this.host.onDone();
  };

  private openConnection(request: ImpSessionRequest): ImpSessionConnection {
    const connection = this.port.openSession(request, {
      onStarted: () => {
        if (this.connection !== connection) {
          return;
        }

        this.started = true;

        for (const bytes of this.pending) {
          connection.write(bytes);
        }

        this.pending = [];
      },
      onOutput: (data) => {
        if (this.connection !== connection) {
          return;
        }

        const text = this.decoder.decode(data, { stream: true });

        for (const listener of this.dataListeners) {
          listener(text);
        }
      },
    });

    void this.waitForOutcome(connection);

    return connection;
  }

  private async waitForOutcome(connection: ImpSessionConnection): Promise<void> {
    const outcome = await connection.outcome;

    this.applyOutcome(connection, outcome);
  }

  private applyOutcome(connection: ImpSessionConnection, outcome: ImpSessionOutcome): void {
    if (this.connection !== connection || this.done || this.host.isSuspending()) {
      return;
    }

    if (outcome.kind === 'exit') {
      this.emitExit({ exitCode: outcome.code ?? 1, reason: 'exited' });

      return;
    }

    this.emitExit({ exitCode: 1, reason: 'ended', detail: formatOutcome(outcome) });
  }

  private emitExit(exit: HarnessExit): void {
    const listeners = [...this.exitListeners];

    this.done = true;
    this.connection = null;

    this.dataListeners.clear();
    this.exitListeners.clear();
    this.host.onDone();

    for (const listener of listeners) {
      listener(exit);
    }
  }
}

// An end other than an exit, as a session's last message.
function formatOutcome(outcome: Exclude<ImpSessionOutcome, { kind: 'exit' }>): string {
  if (outcome.kind === 'failed') {
    return `imp refused the session (${outcome.code ?? 'error'})`;
  }

  if (outcome.kind === 'detached') {
    return `imp detached the session (${outcome.reason})`;
  }

  if (outcome.kind === 'closed') {
    return `imp connection closed (${outcome.reason})`;
  }

  if (outcome.kind === 'unreachable') {
    return 'imp unreachable';
  }

  if (outcome.kind === 'unauthorized') {
    return 'imp refused the token';
  }

  return 'imp sent a bad message';
}
