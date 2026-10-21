import { systemClock } from '@atc/core';
import { createImpClient, openExecSession, openReverseForward } from '@impz/client';
import type { ExecOutcome, ExecSessionOptions, ImpClient } from '@impz/client';
import { match } from 'ts-pattern';
import { z } from 'zod';
import type {
  ImpCommand,
  ImpCommandResult,
  ImpPort,
  ImpSessionOutcome,
  ImpSessionRequest,
} from './imp-port';
import { ImpPortError } from './imp-port-error';
import { openGatedSocket } from './open-gated-socket';
import { openRelay } from './open-relay';
import { requireImpdVersion } from './require-impd-version';
import { toImpIdentity } from './to-imp-identity';
import { toImpLease } from './to-imp-lease';
import { toImpSecret } from './to-imp-secret';
import { toImpView } from './to-imp-view';

interface ImpClientPortOptions {
  readonly url: string;
  readonly readToken: () => string | null;
  readonly now?: () => number;
}

// How long one read of impd's slow status report answers later version
// checks; the version changes only when impd is replaced, which the doc on
// runtime auth weighs.
const VERSION_MAX_AGE_MS = 30_000;

export function createImpClientPort(options: ImpClientPortOptions): ImpPort {
  const url = options.url;
  const readToken = options.readToken;
  const now = options.now ?? systemClock.now;

  // The client for the token read last, rebuilt when the token changes.
  let client: Readonly<{ token: string | null; client: ImpClient }> | null = null;

  // The last read of impd's version under a token, from when it went out,
  // dropped when it rejects.
  let version: Readonly<{
    token: string | null;
    at: number;
    read: Promise<string>;
  }> | null = null;

  // The client that calls impd with the token as it reads now.
  const loadClient = (): ImpClient => {
    const token = readToken();

    if (client === null || client.token !== token) {
      client = {
        token,
        client: createImpClient({ url, ...(token === null ? {} : { token }) }),
      };
    }

    return client.client;
  };

  // Runs one client call, turning impd's refusals and transport failures
  // into port errors.
  const tryCall = async <T>(call: (impClient: ImpClient) => Promise<T>): Promise<T> => {
    try {
      return await call(loadClient());
    } catch (error) {
      throw toPortError(error);
    }
  };

  // The token as it reads now, or the port error its read throws.
  const tryReadToken = (): string | null | ImpPortError => {
    try {
      return readToken();
    } catch (error) {
      return toPortError(error);
    }
  };

  // impd's version, from a read under the same token within the maximum age
  // when one is held.
  const readVersion = (): Promise<string> => {
    const token = tryReadToken();

    if (token instanceof ImpPortError) {
      return Promise.reject(token);
    }

    const at = now();
    const held = version;

    if (held !== null && held.token === token && at - held.at < VERSION_MAX_AGE_MS) {
      return held.read;
    }

    const read = (async (): Promise<string> => {
      try {
        const info = await tryCall((impClient) => impClient.system.info());

        return info.version;
      } catch (error) {
        if (version?.token === token && version.at === at) {
          version = null;
        }

        throw error;
      }
    })();

    version = { token, at, read };

    return read;
  };

  return {
    verifyVersion: async () => {
      const read = await readVersion();

      requireImpdVersion(read);
    },

    readIdentity: async () => {
      const identity = await tryCall((impClient) => impClient.tokens.whoami());

      return toImpIdentity(identity);
    },

    readSecrets: async () => {
      const secrets = await tryCall((impClient) => impClient.secrets.list());

      return secrets.map((secret) => toImpSecret(secret));
    },

    readGrants: async (name) => {
      const grants = await tryCall((impClient) => impClient.grants.list({ name }));

      return [...grants];
    },

    createGrant: async (name, secret) => {
      await tryCall((impClient) => impClient.grants.add({ name, secret }));
    },

    // A grant impd no longer holds is no grant to revoke; a missing imp or
    // secret still rejects.
    removeGrant: async (name, secret) => {
      try {
        await tryCall((impClient) => impClient.grants.delete({ name, secret }));

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
    },

    readImp: async (name) => {
      try {
        const imp = await tryCall((impClient) => impClient.imps.get({ name }));

        return toImpView(imp);
      } catch (error) {
        if (error instanceof ImpPortError && error.code === 'NOT_FOUND') {
          return null;
        }

        throw error;
      }
    },

    createImp: async (spec) => {
      const imp = await tryCall((impClient) =>
        impClient.imps.create({
          name: spec.name,
          ...(spec.image === undefined ? {} : { image: spec.image }),
          ...(spec.memoryMib === undefined ? {} : { memoryMib: spec.memoryMib }),
        }),
      );

      return toImpView(imp);
    },

    acquireLease: async (name, label, ttlSeconds) => {
      const lease = await tryCall((impClient) =>
        impClient.leases.acquire({ name, label, ttlSeconds }),
      );

      return toImpLease(lease);
    },

    renewLease: async (name, label, ttlSeconds) => {
      const lease = await tryCall((impClient) =>
        impClient.leases.renew({ name, label, ttlSeconds }),
      );

      return toImpLease(lease);
    },

    releaseLease: async (name, label) => {
      const result = await tryCall((impClient) => impClient.leases.release({ name, label }));

      return result.released;
    },

    suspendImp: async (name) => {
      await tryCall((impClient) => impClient.imps.sleep({ name }));
    },

    destroyImp: async (name) => {
      await tryCall((impClient) => impClient.imps.destroy({ name }));
    },

    // The exec WebSocket answers only after it opens, so nothing reaches the
    // handlers before this returns.
    openSession: (request, handlers, gate) => {
      const token = tryReadToken();

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
        baseUrl: url,
        token,
        start: buildExecStart(request),
        onStarted: (started) => {
          handlers.onStarted({ created: started.created, output: started.output });
        },
        onOutput: (_channel, data) => {
          handlers.onOutput(data);
        },
        connect: (socketURL, headers) => openGatedSocket(socketURL, headers, gate),
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
    },

    writeReadOnlyFile: async (name, path, content) => {
      const written = await tryCall((impClient) => impClient.files.write({ name, path, content }));

      return written.path;
    },

    // A command's exec WebSocket carries the token in its headers, as a
    // session connection's does, so the command needs no exec ticket from
    // impd before it opens.
    runCommand: (name, command) => {
      const token = tryReadToken();

      if (token instanceof ImpPortError) {
        return Promise.reject(token);
      }

      return runCommandInChunks(url, token, name, command);
    },

    openReverseForward: (name, guestPath, onConnection) => {
      const token = tryReadToken();

      if (token instanceof ImpPortError) {
        return {
          listening: Promise.reject(token),
          ended: Promise.resolve({ kind: 'failed', code: token.code, message: token.message }),
          stop: () => {},
        };
      }

      const forward = openReverseForward({
        baseUrl: url,
        token,
        name,
        guest: { network: 'unix', path: guestPath },

        // The client reuses the headers of the listening socket for every
        // guest connection relay, so each socket reads the token afresh. A
        // token that cannot be read dials without one, which impd refuses.
        connect: (socketURL, headers) => {
          const { authorization: _, ...rest } = headers;
          const current = tryReadToken();

          return new WebSocket(socketURL, {
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
    },
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

// The data of impd's refusal to remove a grant it does not hold, as against
// a missing imp or secret.
const MISSING_GRANT_SCHEMA = z.object({ kind: z.literal('grant') });

function isMissingGrant(data: unknown): boolean {
  return MISSING_GRANT_SCHEMA.safeParse(data).success;
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
