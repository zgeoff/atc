import type { RemoteDaemon } from '@atc/config';
import { systemClock, toAgentID } from '@atc/core';
import type { Clock } from '@atc/core';
import type { DaemonBoot, DaemonBootOptions } from '@atc/protocol';
import { openDaemonClient } from '@atc/protocol/client';
import type { DaemonClient } from '@atc/protocol/client';
import { DaemonError } from '@atc/protocol/wire';
import { CONTRACT_MAJOR } from '@atcx/contract/light';
import { readRemoteDaemonToken } from './read-remote-daemon-token';
import { RemoteTokenError } from './remote-token-error';

const DEFAULT_ANSWER_TIMEOUT_MS = 8000;
const RETRY_INTERVAL_MS = 1000;

// Every failure says so, so a user who expected the remote fleet never
// takes the local one for it.
const NO_FALLBACK = 'atc did not fall back to the local daemon.';

export class RemoteDaemonUnreachableError extends Error {
  constructor(message: string, options?: Readonly<ErrorOptions>) {
    super(message, options);

    this.name = 'RemoteDaemonUnreachableError';
  }
}

interface RemoteBootOptions extends DaemonBootOptions {
  readonly answerTimeoutMs?: number;

  readonly viewer?: string;
}

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
    throw new RemoteTokenError(
      `${error instanceof Error ? error.message : String(error)}. ${NO_FALLBACK}`,
      { cause: error },
    );
  }

  const deadline =
    options.waitForDaemonMs === undefined ? null : clock.now() + options.waitForDaemonMs;

  const capMs = (durationMs: number): number =>
    deadline === null ? durationMs : Math.min(durationMs, deadline - clock.now());

  let waited = false;
  let failure: RemoteDaemonUnreachableError | null = null;

  for (;;) {
    const attemptMs = capMs(timeoutMs);

    if (attemptMs <= 0) {
      throw (
        failure ??
        new RemoteDaemonUnreachableError(
          formatUnreachable(daemon, 'the wait for it ended before an attempt'),
        )
      );
    }

    try {
      return await openRemoteDaemon(daemon, {
        build,
        token,
        clock,
        timeoutMs: attemptMs,
        viewer: options.viewer,
      });
    } catch (error) {
      if (
        !(error instanceof RemoteDaemonUnreachableError) ||
        options.onWaitForDaemon === undefined ||
        capMs(RETRY_INTERVAL_MS) <= 0
      ) {
        throw error;
      }

      failure = error;

      if (!waited) {
        waited = true;

        options.onWaitForDaemon();
      }

      const rested = Promise.withResolvers<void>();

      clock.schedule(rested.resolve, capMs(RETRY_INTERVAL_MS));

      await rested.promise;
    }
  }
}

function formatUnreachable(daemon: RemoteDaemon, detail: string): string {
  return `cannot reach daemon '${daemon.name}' at ${formatRemoteAddress(daemon)}: ${detail}. ${NO_FALLBACK}`;
}

function formatRemoteAddress(daemon: RemoteDaemon): string {
  return daemon.host.includes(':')
    ? `[${daemon.host}]:${daemon.port}`
    : `${daemon.host}:${daemon.port}`;
}

type RemoteAttempt =
  | {
      readonly ok: true;
      readonly client: DaemonClient;
      readonly hello: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly error: unknown };

interface OpenRemoteDaemonOptions {
  readonly build: string;
  readonly token: string;
  readonly clock: Clock;
  readonly timeoutMs: number;
  readonly viewer: string | undefined;
}

async function openRemoteDaemon(
  daemon: RemoteDaemon,
  options: OpenRemoteDaemonOptions,
): Promise<DaemonBoot> {
  const opened: { client: DaemonClient | null; expired: boolean } = {
    client: null,
    expired: false,
  };

  const timeout = Promise.withResolvers<never>();

  const cancel = options.clock.schedule(() => {
    opened.expired = true;
    opened.client?.stop();

    timeout.reject(
      new RemoteDaemonUnreachableError(
        formatUnreachable(daemon, `no handshake answer within ${options.timeoutMs / 1000}s`),
      ),
    );
  }, options.timeoutMs);

  // The attempt resolves with its failure instead of rejecting, so a failure
  // after the timeout won the race is never an unhandled rejection.
  const attempt = (async (): Promise<RemoteAttempt> => {
    try {
      const client = await openRemoteConnection(daemon);

      opened.client = client;

      if (opened.expired) {
        client.stop();
      }

      const hello = await client.sendHello(options.build, {
        token: options.token,
        principal: daemon.principal,
        ...(options.viewer === undefined ? {} : { viewer: options.viewer }),
      });

      // A daemon that predates the viewer drops it from the handshake and
      // would send the events and output of the entry's whole reach.
      if (options.viewer !== undefined && !hasViewerFeature(hello)) {
        return {
          ok: false,
          error: new Error(
            `daemon '${daemon.name}' at ${formatRemoteAddress(daemon)} cannot narrow a connection to the principal '${options.viewer}', so it serves no live terminal to it; update atc on the daemon's host`,
          ),
        };
      }

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

      // never stale, since this client cannot restart a daemon on another host
      stale: false,
      lastUsedAgent: toAgentID(answered.hello['lastUsedAgent']),
      socketPath: formatRemoteAddress(daemon),
    };
  } catch (error) {
    opened.client?.stop();
    throw toRemoteBootError(daemon, options.build, error);
  } finally {
    cancel();
  }
}

async function openRemoteConnection(daemon: RemoteDaemon): Promise<DaemonClient> {
  try {
    return await openDaemonClient({ hostname: daemon.host, port: daemon.port });
  } catch (error) {
    throw new RemoteDaemonUnreachableError(formatUnreachable(daemon, formatConnectError(error)), {
      cause: error,
    });
  }
}

function formatConnectError(error: unknown): string {
  const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined;

  if (typeof code === 'string') {
    return code;
  }

  return error instanceof Error ? error.message : String(error);
}

function hasViewerFeature(hello: Readonly<Record<string, unknown>>): boolean {
  const features = hello['features'];

  return Array.isArray(features) && features.includes('daemon.hello.viewer');
}

function toRemoteBootError(daemon: RemoteDaemon, build: string, error: unknown): unknown {
  if (!(error instanceof DaemonError)) {
    return error;
  }

  if (error.code === 'protocol_mismatch') {
    return new DaemonError(
      'protocol_mismatch',
      [
        `daemon '${daemon.name}' at ${formatRemoteAddress(daemon)} speaks another major version than this client, ${build} on major version ${CONTRACT_MAJOR}.`,
        `The daemon answered: ${error.message}`,
        `${NO_FALLBACK} Run an atc build on the daemon's major version here, or update the daemon on its host.`,
      ].join('\n'),
    );
  }

  if (error.code === 'unauthorized') {
    return new DaemonError(
      'unauthorized',
      `daemon '${daemon.name}' at ${formatRemoteAddress(daemon)} refused the handshake as principal '${daemon.principal}': ${error.message}. ${NO_FALLBACK}`,
    );
  }

  // During the handshake an internal error means the connection closed before the answer: the
  // daemon went away or something in front of it dropped the connection. Report it as unreachable,
  // not as a refusal.
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
