import type { RemoteDaemon } from '@atc/config';
import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import { openDaemonClient } from '@atc/protocol/client';
import type { DaemonClient } from '@atc/protocol/client';
import { DaemonError } from '@atc/protocol/wire';
import {
  RemoteDaemonUnreachableError,
  bootRemoteDaemonClient,
} from '../remote-daemon/boot-remote-daemon-client';
import { RemoteTokenError } from '../remote-daemon/remote-token-error';
import type { CommandError, ConnectResult, ConnectTarget, SendConnection } from './types';

const HELLO_LIMIT_MS = 8000;

// A send is not an atc client; the daemon labels a client with this name `local`.
const SEND_CLIENT = 'atc-send';

interface SendConnectionSource {
  readonly socketPath: string;

  // The build string an atc client names itself with in the handshake.
  readonly build: string;

  readonly session: string | undefined;
  readonly clock?: Clock;

  readonly resolveDaemon: (
    name: string,
  ) =>
    | { readonly ok: true; readonly daemon: RemoteDaemon }
    | { readonly ok: false; readonly message: string };
}

export async function openSendConnection(
  target: Readonly<ConnectTarget>,
  source: Readonly<SendConnectionSource>,
): Promise<ConnectResult> {
  const clock = source.clock ?? systemClock;

  if (target.kind === 'remote') {
    return openRemoteSendConnection(target.name, source, clock);
  }

  let client: DaemonClient;

  try {
    client = await openDaemonClient(source.socketPath);
  } catch (error) {
    return failed('unreachable', `no daemon at ${source.socketPath}: ${describe(error)}`);
  }

  const expired = Promise.withResolvers<never>();

  const cancel = clock.schedule(() => {
    client.stop();

    expired.reject(
      new DaemonError('internal', `no handshake answer within ${HELLO_LIMIT_MS / 1000}s`),
    );
  }, HELLO_LIMIT_MS);

  const clientName = target.owner ? source.build : SEND_CLIENT;
  const session = source.session === undefined ? {} : { session: source.session };

  try {
    await Promise.race([client.sendHello(clientName, session), expired.promise]);
  } catch (error) {
    client.stop();

    if (error instanceof DaemonError && error.code !== 'internal') {
      return failed(error.code, error.message);
    }

    return failed(
      'unreachable',
      `the daemon at ${source.socketPath} gave no handshake answer: ${describe(error)}`,
    );
  } finally {
    cancel();
  }

  return { ok: true, connection: makeSendConnection(client, clock) };
}

async function openRemoteSendConnection(
  name: string,
  source: Readonly<SendConnectionSource>,
  clock: Clock,
): Promise<ConnectResult> {
  const found = source.resolveDaemon(name);

  if (!found.ok) {
    return failed('no_such_daemon', found.message);
  }

  try {
    const booted = await bootRemoteDaemonClient(found.daemon, source.build, { clock });

    return { ok: true, connection: makeSendConnection(booted.client, clock) };
  } catch (error) {
    if (error instanceof RemoteTokenError) {
      return failed('remote_token', error.message);
    }

    if (error instanceof RemoteDaemonUnreachableError) {
      return failed('unreachable', error.message);
    }

    if (error instanceof DaemonError) {
      return failed(error.code, error.message);
    }

    return failed('internal', describe(error));
  }
}

function failed(code: string, message: string): ConnectResult {
  const error: CommandError = { code, message };

  return { ok: false, error };
}

function makeSendConnection(client: DaemonClient, clock: Clock): SendConnection {
  return {
    request: async (method, params, limitMs) => {
      const expired = Promise.withResolvers<never>();

      const cancel = clock.schedule(() => {
        client.stop();

        expired.reject(
          new DaemonError('internal', `no answer to ${method} within ${limitMs / 1000}s`),
        );
      }, limitMs);

      try {
        return await Promise.race([client.sendRequest(method, params), expired.promise]);
      } finally {
        cancel();
      }
    },
    isClosed: () => client.isClosed(),
    stop: () => {
      client.stop();
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
