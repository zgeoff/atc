import { createImpClient, openExecSession, openReverseForward } from '@impz/client';
import type { ExecOutcome, ExecSessionOptions, ImpClient } from '@impz/client';
import { match } from 'ts-pattern';
import { z } from 'zod';
import type {
  ImpCommand,
  ImpCommandResult,
  ImpCreateSpec,
  ImpFeatures,
  ImpIdentity,
  ImpLease,
  ImpPort,
  ImpRelayConnection,
  ImpReverseForward,
  ImpSecret,
  ImpSessionConnection,
  ImpSessionHandlers,
  ImpSessionOutcome,
  ImpSessionRequest,
  ImpView,
} from './imp-port';
import { ImpPortError } from './imp-port-error';
import { toImpFeatures } from './to-imp-features';
import { toImpIdentity } from './to-imp-identity';
import { toImpLease } from './to-imp-lease';
import { toImpSecret } from './to-imp-secret';
import { toImpView } from './to-imp-view';

interface ImpClientPortOptions {
  readonly url: string;
  readonly readToken: () => string | null;
}

export class ImpClientPort implements ImpPort {
  private readonly url: string;

  private readonly readToken: () => string | null;

  // The client for the token read last, rebuilt when the token changes.
  private client: Readonly<{ token: string | null; client: ImpClient }> | null = null;

  constructor(options: ImpClientPortOptions) {
    this.url = options.url;
    this.readToken = options.readToken;
  }

  readonly readFeatures = async (): Promise<ImpFeatures> => {
    const info = await this.tryCall((client) => client.system.info());

    return toImpFeatures(info);
  };

  readonly readIdentity = async (): Promise<ImpIdentity> => {
    const identity = await this.tryCall((client) => client.tokens.whoami());

    return toImpIdentity(identity);
  };

  readonly readSecrets = async (): Promise<readonly ImpSecret[]> => {
    const secrets = await this.tryCall((client) => client.secrets.list());

    return secrets.map((secret) => toImpSecret(secret));
  };

  readonly readGrants = async (name: string): Promise<readonly string[]> => {
    const grants = await this.tryCall((client) => client.grants.list({ name }));

    return [...grants];
  };

  readonly createGrant = async (name: string, secret: string): Promise<void> => {
    await this.tryCall((client) => client.grants.add({ name, secret }));
  };

  // A grant impd no longer holds is no grant to revoke; a missing imp or
  // secret still rejects.
  readonly removeGrant = async (name: string, secret: string): Promise<boolean> => {
    try {
      await this.tryCall((client) => client.grants.delete({ name, secret }));

      return true;
    } catch (error) {
      if (
        error instanceof ImpPortError &&
        error.code === 'NOT_FOUND' &&
        isMissingGrant(error.data)
      ) {
        return false;
      }

      throw error;
    }
  };

  readonly readImp = async (name: string): Promise<ImpView | null> => {
    try {
      const imp = await this.tryCall((client) => client.imps.get({ name }));

      return toImpView(imp);
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

    return toImpView(imp);
  };

  readonly acquireLease = async (
    name: string,
    label: string,
    ttlSeconds: number,
  ): Promise<ImpLease> => {
    const lease = await this.tryCall((client) =>
      client.leases.acquire({ name, label, ttlSeconds }),
    );

    return toImpLease(lease);
  };

  readonly renewLease = async (
    name: string,
    label: string,
    ttlSeconds: number,
  ): Promise<ImpLease> => {
    const lease = await this.tryCall((client) => client.leases.renew({ name, label, ttlSeconds }));

    return toImpLease(lease);
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
    gate?: () => boolean,
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
      start: buildExecStart(request),
      onStarted: (started) => {
        handlers.onStarted({ created: started.created, output: started.output });
      },
      onOutput: (_channel, data) => {
        handlers.onOutput(data);
      },
      connect: (url, headers) => openGatedSocket(url, headers, gate),
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

  readonly writeReadOnlyFile = async (
    name: string,
    path: string,
    content: string,
  ): Promise<string> => {
    const written = await this.tryCall((client) => client.files.write({ name, path, content }));

    return written.path;
  };

  // A command's exec WebSocket carries the token in its headers, as a
  // session connection's does, so the command needs no exec ticket from
  // impd before it opens.
  readonly runCommand = (name: string, command: ImpCommand): Promise<ImpCommandResult> => {
    const token = this.tryReadToken();

    if (token instanceof ImpPortError) {
      return Promise.reject(token);
    }

    return runCommandInChunks(this.url, token, name, command);
  };

  readonly openReverseForward = (
    name: string,
    guestPath: string,
    onConnection: (connection: ImpRelayConnection) => void,
  ): ImpReverseForward => {
    const token = this.tryReadToken();

    if (token instanceof ImpPortError) {
      return {
        listening: Promise.reject(token),
        ended: Promise.resolve({ kind: 'failed', code: token.code, message: token.message }),
        stop: () => {},
      };
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
      ended: forward.ended,
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

// The data of impd's refusal to remove a grant it does not hold, as against
// a missing imp or secret.
const MISSING_GRANT_SCHEMA = z.object({ kind: z.literal('grant') });

function isMissingGrant(data: unknown): boolean {
  return MISSING_GRANT_SCHEMA.safeParse(data).success;
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

// A start or an attach as impd's exec protocol takes it: an attach carries
// no requirements, and a start carries its requirements and its drop of
// CAP_SYS_ADMIN.
function buildExecStart(request: ImpSessionRequest): ExecSessionOptions['start'] {
  if (request.kind === 'attach') {
    return {
      name: request.name,
      session: request.session,
      cols: request.cols,
      rows: request.rows,
      wake: request.wake,
      ...(request.resumeFrom === undefined ? {} : { resumeFrom: request.resumeFrom }),
    };
  }

  return {
    name: request.name,
    session: request.session,
    argv: request.argv,
    tty: true,
    env: request.env,
    cwd: request.cwd,
    cols: request.cols,
    rows: request.rows,
    ...(request.resumeFrom === undefined ? {} : { resumeFrom: request.resumeFrom }),
    ...(request.require === undefined ? {} : { require: request.require }),
    ...(request.dropSysAdmin === true ? { dropSysAdmin: true } : {}),
  };
}

async function waitForSessionOutcome(outcome: Promise<ExecOutcome>): Promise<ImpSessionOutcome> {
  const ended = await outcome;

  return match(ended)
    .returnType<ImpSessionOutcome>()
    .with({ kind: 'local_error' }, (failed) => ({
      kind: 'local_error',
      detail: failed.error instanceof Error ? failed.error.message : String(failed.error),
    }))
    .with({ kind: 'unauthorized' }, () => ({ kind: 'unauthorized' }))
    .otherwise((other) => other);
}

// impd takes no WebSocket message over its size limit and closes the exec
// when one arrives, so a command's input goes over in pieces well below it.
const STDIN_CHUNK_BYTES = 1024 * 1024;

// A command that ends before it takes all its input answers with its own exit;
// an exec that ends any other way rejects.
async function runCommandInChunks(
  url: string,
  token: string | null,
  name: string,
  command: ImpCommand,
): Promise<ImpCommandResult> {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const started = Promise.withResolvers<void>();

  const session = openExecSession({
    baseUrl: url,
    token,
    start: {
      name,
      argv: command.argv,
      tty: false,
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
    },
    onStarted: () => {
      started.resolve();
    },
    onOutput: (channel, data) => {
      (channel === 'stderr' ? stderr : stdout).push(data);
    },
    connect: (socketURL, headers) => new WebSocket(socketURL, { headers }),
  });

  const state = { ended: false };

  const outcome = (async () => {
    const ended = await session.outcome;

    state.ended = true;

    return ended;
  })();

  await Promise.race([started.promise, outcome]);

  const stdin = command.stdin ?? new Uint8Array(0);

  for (let at = 0; at < stdin.byteLength && !state.ended; at += STDIN_CHUNK_BYTES) {
    if (!session.sendStdin(stdin.subarray(at, at + STDIN_CHUNK_BYTES))) {
      await session.waitForDrain();
    }
  }

  session.closeStdin();

  const ended = await outcome;

  if (ended.kind !== 'exit') {
    throw toCommandError(ended);
  }

  return { code: ended.code, stdout: mergeChunks(stdout), stderr: mergeChunks(stderr) };
}

// An exec that ended without an exit, under the code impd's client gives
// the same ending.
function toCommandError(ended: Exclude<ExecOutcome, { kind: 'exit' }>): ImpPortError {
  return match(ended)
    .returnType<ImpPortError>()
    .with(
      { kind: 'failed' },
      (failed) => new ImpPortError(failed.code ?? 'EXEC_ERROR', failed.message, failed.data),
    )
    .with(
      { kind: 'unauthorized' },
      () => new ImpPortError('UNAUTHORIZED', 'impd rejected the token'),
    )
    .with(
      { kind: 'unreachable' },
      (failed) => new ImpPortError('UNREACHABLE', `cannot reach impd (${failed.detail})`),
    )
    .with(
      { kind: 'detached' },
      (failed) => new ImpPortError('DETACHED', `detached from the session (${failed.reason})`),
    )
    .with(
      { kind: 'closed', closeCode: 1012 },
      () => new ImpPortError('RESTARTING', 'impd is restarting'),
    )
    .with(
      { kind: 'closed' },
      (failed) =>
        new ImpPortError('CONNECTION_CLOSED', `exec connection closed (${failed.reason})`),
    )
    .with(
      { kind: 'bad_message' },
      (failed) => new ImpPortError('BAD_MESSAGE', `bad message from impd: ${failed.detail}`),
    )
    .with({ kind: 'local_error' }, () => new ImpPortError('LOCAL_ERROR', 'an output handler threw'))
    .exhaustive();
}

function mergeChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const merged = Buffer.concat(chunks);

  return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
}

async function waitForListening(listening: Promise<unknown>): Promise<void> {
  await listening;
}

// How the client hands over a guest connection: the daemon accepts it with
// its handlers and gets the relay back.
type RelayAccept = (
  handlers: Readonly<{
    onData: (data: Uint8Array) => void;
    onEof: () => void;
    onClose: (lost: boolean) => void;
  }>,
) => Readonly<{
  send: (data: Uint8Array) => boolean;
  waitForRoom: () => Promise<void>;
  close: () => void;
}>;

// Takes a guest connection at once, handing its bytes and its close to the
// listeners the relay's owner adds.
function openRelay(accept: RelayAccept): ImpRelayConnection {
  const dataListeners: ((data: Uint8Array) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  const endListeners: (() => void)[] = [];

  const relay = accept({
    onData: (data) => {
      for (const listener of dataListeners) {
        listener(data);
      }
    },
    onEof: () => {
      for (const listener of endListeners) {
        listener();
      }
    },
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
    onEnd: (listener) => {
      endListeners.push(listener);
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

// The client sends the request as the socket's first message and holds every
// other until then, so the gate runs on that send. A closed or throwing gate
// closes the socket and drops every later message.
function openGatedSocket(
  url: string,
  headers: Readonly<Record<string, string>>,
  gate: (() => boolean) | undefined,
): WebSocket {
  const socket = new WebSocket(url, { headers });

  if (gate === undefined) {
    return socket;
  }

  const send = socket.send.bind(socket);
  const state: { passed: boolean | null } = { passed: null };

  socket.send = (data) => {
    if (state.passed === null) {
      state.passed = tryPassGate(gate);

      if (!state.passed) {
        socket.close(1000, 'closed before sending');
      }
    }

    if (state.passed) {
      send(data);
    }
  };

  return socket;
}

function tryPassGate(gate: () => boolean): boolean {
  try {
    return gate();
  } catch {
    return false;
  }
}
