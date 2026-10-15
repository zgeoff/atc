import type { RemoteDaemon } from '@atc/config/collect-remote-daemons';
import { systemClock } from '@atc/core/system-clock';
import type { Clock } from '@atc/core/system-clock';
import { toAgentID } from '@atc/core/to-agent-id';
import { DaemonClient } from '@atc/protocol/client/daemon-client';
import type { DaemonBoot } from '@atc/protocol/daemon-boot';
import type { DaemonBootOptions } from '@atc/protocol/daemon-boot-options';
import { DaemonError } from '@atc/protocol/daemon-error';
import { parseDaemonFeatures } from '@atc/protocol/parse-daemon-features';
import { PROTOCOL_V } from '@atc/protocol/protocol';
import { readRemoteDaemonToken } from './read-remote-daemon-token';

// How long one attempt gives the remote daemon to take the connection and
// answer the handshake, the same budget a local boot gives its daemon.
const DEFAULT_ANSWER_TIMEOUT_MS = 8000;

// How long a waiting boot rests between attempts.
const RETRY_INTERVAL_MS = 1000;

// Every failure says so, so a user who expected the remote fleet never
// takes the local one for it.
const NO_FALLBACK = 'The TUI did not fall back to the local daemon.';

/**
 * A remote daemon that refused the connection, closed it before its
 * handshake answer, or did not answer in time: the one failure a waiting
 * boot tries again.
 */
class RemoteDaemonUnreachableError extends Error {
  constructor(message: string, options?: Readonly<ErrorOptions>) {
    super(message, options);

    this.name = 'RemoteDaemonUnreachableError';
  }
}

interface RemoteBootOptions extends DaemonBootOptions {
  // How long one attempt waits for the daemon to answer; 8 seconds unless
  // set.
  readonly answerTimeoutMs?: number;
}

/**
 * Opens a handshaken client to a daemon on another host over TCP,
 * presenting the bearer token its config entry points at, and makes every
 * request of the client act as the entry's principal. It never starts,
 * finds, or restarts a local daemon, so a failure rejects with a message
 * that holds the daemon's name and address and says the TUI did not fall
 * back to the local daemon. A daemon on another protocol rejects with
 * `protocol_mismatch` and both builds and both versions, and the boot never
 * offers to restart it: `onProtocolMismatch` is not called. A refused token
 * rejects with `unauthorized`. An unreachable daemon rejects at once,
 * unless the options hold `onWaitForDaemon`: the boot then calls it once
 * and tries again each second until the daemon answers, as a client whose
 * connection dropped waits for its daemon to return. The boot reports the
 * daemon as never stale, since this client cannot restart it, and holds
 * its `<host>:<port>` where a local boot holds its socket path.
 */
export async function bootRemoteDaemonClient(
  daemon: RemoteDaemon,
  build: string,
  options: RemoteBootOptions = {},
): Promise<DaemonBoot> {
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
  let token: string;

  try {
    token = await readRemoteDaemonToken(daemon);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}. ${NO_FALLBACK}`, {
      cause: error,
    });
  }

  let waited = false;

  for (;;) {
    try {
      return await openRemoteDaemon(daemon, build, token, clock, timeoutMs);
    } catch (error) {
      if (
        !(error instanceof RemoteDaemonUnreachableError) ||
        options.onWaitForDaemon === undefined
      ) {
        throw error;
      }

      if (!waited) {
        waited = true;

        options.onWaitForDaemon();
      }

      const rested = Promise.withResolvers<void>();

      clock.schedule(rested.resolve, RETRY_INTERVAL_MS);

      await rested.promise;
    }
  }
}

// One attempt's outcome: the handshaken connection, or why it failed.
type RemoteAttempt =
  | {
      readonly ok: true;
      readonly client: DaemonClient;
      readonly hello: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly error: unknown };

async function openRemoteDaemon(
  daemon: RemoteDaemon,
  build: string,
  token: string,
  clock: Clock,
  timeoutMs: number,
): Promise<DaemonBoot> {
  // The connection, once open, so a timeout or a failed handshake closes
  // it; a property, since the attempt sets it after the race starts.
  const opened: { client: DaemonClient | null; expired: boolean } = {
    client: null,
    expired: false,
  };

  const timeout = Promise.withResolvers<never>();

  const cancel = clock.schedule(() => {
    opened.expired = true;
    opened.client?.stop();

    timeout.reject(
      new RemoteDaemonUnreachableError(
        formatUnreachable(daemon, `no handshake answer within ${timeoutMs / 1000}s`),
      ),
    );
  }, timeoutMs);

  // The attempt resolves with its failure instead of rejecting, so a failure
  // after the timeout won the race is never an unhandled rejection.
  const attempt = (async (): Promise<RemoteAttempt> => {
    try {
      const client = await openRemoteConnection(daemon);

      opened.client = client;

      // A connection that opens after the attempt gave up is closed at once.
      if (opened.expired) {
        client.stop();
      }

      const hello = await client.sendHello(build, { token, principal: daemon.principal });

      client.principal = daemon.principal;

      return { ok: true, client, hello };
    } catch (error) {
      return { ok: false, error };
    }
  })();

  try {
    const answered = await Promise.race([attempt, timeout.promise]);

    if (!answered.ok) {
      throw answered.error;
    }

    return {
      client: answered.client,
      stale: false,
      lastUsedAgent: toAgentID(answered.hello['lastUsedAgent']),
      features: parseDaemonFeatures(answered.hello),
      socketPath: formatRemoteAddress(daemon),
    };
  } catch (error) {
    opened.client?.stop();
    throw toRemoteBootError(daemon, build, error);
  } finally {
    cancel();
  }
}

// Opens the TCP connection; a refusal is the daemon being unreachable.
async function openRemoteConnection(daemon: RemoteDaemon): Promise<DaemonClient> {
  try {
    return await DaemonClient.open({ hostname: daemon.host, port: daemon.port });
  } catch (error) {
    throw new RemoteDaemonUnreachableError(formatUnreachable(daemon, formatConnectError(error)), {
      cause: error,
    });
  }
}

// A handshake failure as the error the boot rejects with; one the boot
// itself raised passes through.
function toRemoteBootError(daemon: RemoteDaemon, build: string, error: unknown): unknown {
  if (!(error instanceof DaemonError)) {
    return error;
  }

  if (error.code === 'protocol_mismatch') {
    return new DaemonError(
      'protocol_mismatch',
      [
        `daemon '${daemon.name}' at ${formatRemoteAddress(daemon)} speaks another protocol than this client, ${build} on protocol v${PROTOCOL_V}.`,
        `The daemon answered: ${error.message}`,
        `${NO_FALLBACK} Run an atc build on the daemon's protocol here, or update the daemon on its host.`,
      ].join('\n'),
    );
  }

  if (error.code === 'unauthorized') {
    return new DaemonError(
      'unauthorized',
      `daemon '${daemon.name}' at ${formatRemoteAddress(daemon)} refused the token: ${error.message}. ${NO_FALLBACK}`,
    );
  }

  // The connection closed before the handshake answer: the daemon went
  // away, or something in front of it dropped the connection.
  if (error.code === 'internal') {
    return new RemoteDaemonUnreachableError(
      formatUnreachable(
        daemon,
        `the connection closed before the handshake answer (${error.message})`,
      ),
    );
  }

  return new DaemonError(
    error.code,
    `daemon '${daemon.name}' at ${formatRemoteAddress(daemon)} refused the handshake: ${error.message}. ${NO_FALLBACK}`,
  );
}

function formatUnreachable(daemon: RemoteDaemon, detail: string): string {
  return `cannot reach daemon '${daemon.name}' at ${formatRemoteAddress(daemon)}: ${detail}. ${NO_FALLBACK}`;
}

// The runtime's code for a refused or unresolved connection, or its
// message when it gives none.
function formatConnectError(error: unknown): string {
  const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined;

  if (typeof code === 'string') {
    return code;
  }

  return error instanceof Error ? error.message : String(error);
}

function formatRemoteAddress(daemon: RemoteDaemon): string {
  return daemon.host.includes(':')
    ? `[${daemon.host}]:${daemon.port}`
    : `${daemon.host}:${daemon.port}`;
}
