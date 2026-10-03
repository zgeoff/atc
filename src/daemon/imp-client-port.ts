import { createImpClient, openExecSession, openReverseForward } from '@zgeoff/imp-client';
import type { ExecOutcome, ImpClient } from '@zgeoff/imp-client';
import type {
  ImpCommand,
  ImpCommandResult,
  ImpCreateSpec,
  ImpFeatures,
  ImpLease,
  ImpPort,
  ImpRelayConnection,
  ImpReverseForward,
  ImpSessionConnection,
  ImpSessionHandlers,
  ImpSessionOutcome,
  ImpSessionRequest,
  ImpView,
} from './imp-port';
import { ImpPortError } from './imp-port-error';

/**
 * Where impd listens, and how the daemon reads the token it calls impd
 * with: null for no token. The port reads the token again before each
 * call and connection, so a token that changes at its source takes effect
 * on the next one. A read that throws fails that call without reaching
 * impd.
 */
export interface ImpClientPortOptions {
  readonly url: string;
  readonly readToken: () => string | null;
}

/**
 * The imp port over `@zgeoff/imp-client`: RPC calls for imps and leases,
 * one exec WebSocket per session connection, and one reverse forward per
 * guest socket. Every refusal impd sends becomes an `ImpPortError` with its
 * code and data, and a call that never reaches impd carries `UNREACHABLE`.
 */
export class ImpClientPort implements ImpPort {
  private readonly url: string;

  private readonly readToken: () => string | null;

  // The client for the token read last, rebuilt when the token changes.
  private client: Readonly<{ token: string | null; client: ImpClient }> | null = null;

  constructor(options: ImpClientPortOptions) {
    this.url = options.url;
    this.readToken = options.readToken;
  }

  // An impd from before the flags has neither.
  readonly readFeatures = async (): Promise<ImpFeatures> => {
    const info = await this.tryCall((client) => client.system.info());

    return info.features ?? { sessionOffsets: false, leases: false };
  };

  readonly readImp = async (name: string): Promise<ImpView | null> => {
    try {
      const imp = await this.tryCall((client) => client.imps.get({ name }));

      return {
        name: imp.name,
        state: imp.state,
        leases: (imp.leases?.leases ?? []).map((lease) => toLease(lease)),
        otherLeaseCount: imp.leases?.otherCount ?? 0,
      };
    } catch (error) {
      if (error instanceof ImpPortError && error.code === 'NOT_FOUND') {
        return null;
      }

      throw error;
    }
  };

  readonly createImp = async (spec: ImpCreateSpec): Promise<ImpView> => {
    const imp = await this.tryCall((client) =>
      client.imps.create({
        name: spec.name,
        ...(spec.image === undefined ? {} : { image: spec.image }),
        ...(spec.memoryMib === undefined ? {} : { memoryMib: spec.memoryMib }),
      }),
    );

    return { name: imp.name, state: imp.state, leases: [], otherLeaseCount: 0 };
  };

  readonly acquireLease = async (
    name: string,
    label: string,
    ttlSeconds: number,
  ): Promise<ImpLease> => {
    const lease = await this.tryCall((client) =>
      client.leases.acquire({ name, label, ttlSeconds }),
    );

    return toLease(lease);
  };

  readonly renewLease = async (
    name: string,
    label: string,
    ttlSeconds: number,
  ): Promise<ImpLease> => {
    const lease = await this.tryCall((client) => client.leases.renew({ name, label, ttlSeconds }));

    return toLease(lease);
  };

  readonly releaseLease = async (name: string, label: string): Promise<boolean> => {
    const result = await this.tryCall((client) => client.leases.release({ name, label }));

    return result.released;
  };

  readonly suspendImp = async (name: string): Promise<void> => {
    await this.tryCall((client) => client.imps.sleep({ name }));
  };

  readonly destroyImp = async (name: string): Promise<void> => {
    await this.tryCall((client) => client.imps.destroy({ name }));
  };

  // The exec WebSocket answers only after it opens, so nothing reaches the
  // handlers before this returns.
  readonly openSession = (
    request: ImpSessionRequest,
    handlers: ImpSessionHandlers,
  ): ImpSessionConnection => {
    const token = this.tryReadToken();

    // A token that cannot be read ends the connection the way impd's
    // refusal of a token does, without dialing impd.
    if (token instanceof ImpPortError) {
      return {
        outcome: Promise.resolve({ kind: 'unauthorized' }),
        write: () => {},
        resize: () => {},
        sendSignal: () => {},
        close: () => {},
      };
    }

    const session = openExecSession({
      baseUrl: this.url,
      token,
      start:
        request.kind === 'start'
          ? {
              name: request.name,
              session: request.session,
              argv: request.argv,
              tty: true,
              env: request.env,
              cwd: request.cwd,
              cols: request.cols,
              rows: request.rows,
              ...(request.resumeFrom === undefined ? {} : { resumeFrom: request.resumeFrom }),
            }
          : {
              name: request.name,
              session: request.session,
              cols: request.cols,
              rows: request.rows,
              wake: request.wake,
              ...(request.resumeFrom === undefined ? {} : { resumeFrom: request.resumeFrom }),
            },
      onStarted: (started) => {
        handlers.onStarted({ created: started.created, output: started.output });
      },
      onOutput: (_channel, data) => {
        handlers.onOutput(data);
      },
      connect: (url, headers) => new WebSocket(url, { headers }),
    });

    return {
      outcome: waitForSessionOutcome(session.outcome),
      write: (data) => {
        session.sendStdin(data);
      },
      resize: (cols, rows) => {
        session.resize(cols, rows);
      },
      sendSignal: (signal) => {
        session.sendSignal(signal);
      },
      close: () => {
        session.stop();
      },
    };
  };

  // oxlint-disable-next-line prefer-readonly-parameter-types -- the command's input bytes have no readonly form
  readonly runCommand = async (name: string, command: ImpCommand): Promise<ImpCommandResult> => {
    const result = await this.tryCall((client) =>
      client.run(name, command.argv, {
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
      }),
    );

    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  };

  readonly openReverseForward = (
    name: string,
    guestPath: string,
    onConnection: (connection: ImpRelayConnection) => void,
  ): ImpReverseForward => {
    const token = this.tryReadToken();

    if (token instanceof ImpPortError) {
      return { listening: Promise.reject(token), stop: () => {} };
    }

    const forward = openReverseForward({
      baseUrl: this.url,
      token,
      name,
      guest: { network: 'unix', path: guestPath },

      // The client reuses the headers of the listening socket for every
      // guest connection relay, so each socket reads the token afresh. A
      // token that cannot be read dials without one, which impd refuses.
      connect: (url, headers) => {
        const { authorization: _, ...rest } = headers;
        const current = this.tryReadToken();

        return new WebSocket(url, {
          headers:
            typeof current === 'string' ? { ...rest, authorization: `Bearer ${current}` } : rest,
        });
      },
      onConnection: (accept) => {
        onConnection(openRelay(accept));
      },
    });

    return {
      listening: waitForListening(forward.listening),
      stop: () => {
        forward.stop();
      },
    };
  };

  // Runs one client call, turning impd's refusals and transport failures
  // into port errors.
  private async tryCall<T>(call: (client: ImpClient) => Promise<T>): Promise<T> {
    try {
      return await call(this.loadClient());
    } catch (error) {
      throw toPortError(error);
    }
  }

  // The token as it reads now, or the port error its read throws.
  private tryReadToken(): string | null | ImpPortError {
    try {
      return this.readToken();
    } catch (error) {
      return toPortError(error);
    }
  }

  // The client that calls impd with the token as it reads now.
  private loadClient(): ImpClient {
    const token = this.readToken();

    if (this.client === null || this.client.token !== token) {
      this.client = {
        token,
        client: createImpClient({ url: this.url, ...(token === null ? {} : { token }) }),
      };
    }

    return this.client.client;
  }
}

// A lease as the client returns it.
interface ClientLease {
  readonly name: string;
  readonly owner: Readonly<{ principal: string; display: string; label: string }>;
  readonly until: Date | null;
}

// oxlint-disable-next-line prefer-readonly-parameter-types -- a lease's end is a Date
function toLease(lease: ClientLease): ImpLease {
  return {
    name: lease.name,
    owner: {
      principal: lease.owner.principal,
      display: lease.owner.display,
      label: lease.owner.label,
    },
    until: lease.until?.getTime() ?? null,
  };
}

function toPortError(error: unknown): ImpPortError {
  if (error instanceof ImpPortError) {
    return error;
  }

  // impd's refusals arrive as errors carrying impd's code and data.
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    const data: unknown = 'data' in error ? error.data : undefined;

    return new ImpPortError(error.code, error.message, data);
  }

  const message = error instanceof Error ? error.message : String(error);

  return new ImpPortError('UNREACHABLE', message);
}

// oxlint-disable-next-line prefer-readonly-parameter-types -- a promise is a live handle
async function waitForSessionOutcome(outcome: Promise<ExecOutcome>): Promise<ImpSessionOutcome> {
  const ended = await outcome;

  if (ended.kind === 'local_error') {
    return {
      kind: 'local_error',
      detail: ended.error instanceof Error ? ended.error.message : String(ended.error),
    };
  }

  if (ended.kind === 'unauthorized') {
    return { kind: 'unauthorized' };
  }

  return ended;
}

// oxlint-disable-next-line prefer-readonly-parameter-types -- a promise is a live handle
async function waitForListening(listening: Promise<unknown>): Promise<void> {
  await listening;
}

// How the client hands over a guest connection: the daemon accepts it with
// its handlers and gets the relay back.
type RelayAccept = (
  handlers: Readonly<{
    // oxlint-disable-next-line prefer-readonly-parameter-types -- relayed bytes have no readonly form
    onData: (data: Uint8Array) => void;
    onEof: () => void;
    onClose: (lost: boolean) => void;
  }>,
) => Readonly<{
  // oxlint-disable-next-line prefer-readonly-parameter-types -- relayed bytes have no readonly form
  send: (data: Uint8Array) => boolean;
  waitForRoom: () => Promise<void>;
  close: () => void;
}>;

// Takes a guest connection at once, handing its bytes and its close to the
// listeners the relay's owner adds.
function openRelay(accept: RelayAccept): ImpRelayConnection {
  // oxlint-disable-next-line prefer-readonly-parameter-types -- relayed bytes have no readonly form
  const dataListeners: ((data: Uint8Array) => void)[] = [];
  const closeListeners: (() => void)[] = [];

  const relay = accept({
    onData: (data) => {
      for (const listener of dataListeners) {
        listener(data);
      }
    },
    onEof: () => {},
    onClose: () => {
      for (const listener of closeListeners) {
        listener();
      }
    },
  });

  return {
    onData: (listener) => {
      dataListeners.push(listener);
    },
    onClose: (listener) => {
      closeListeners.push(listener);
    },

    // A send past the relay's window still queues the bytes, so only the
    // next write waits; a closed relay takes bytes and drops them.
    write: async (data) => {
      if (!relay.send(data)) {
        await relay.waitForRoom();
      }
    },
    close: () => {
      relay.close();
    },
  };
}
