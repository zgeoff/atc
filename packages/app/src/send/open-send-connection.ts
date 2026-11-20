import type { RemoteDaemon } from '@atc/config';
import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import type { DaemonClient } from '@atc/protocol/client';
import { connect } from '@atcx/client';
import type { AtcClient } from '@atcx/client';
import { toMessageID, toSessionID } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';
import {
  RemoteDaemonUnreachableError,
  bootRemoteDaemonClient,
} from '../remote-daemon/boot-remote-daemon-client';
import { RemoteTokenError } from '../remote-daemon/remote-token-error';
import type {
  CommandError,
  ConnectResult,
  ConnectTarget,
  SendCalls,
  SendConnection,
} from './types';

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

  const clientName = target.owner ? source.build : SEND_CLIENT;

  try {
    const client = await connect({
      socketPath: source.socketPath,
      client: clientName,
      timeoutMs: HELLO_LIMIT_MS,
      ...(source.session === undefined ? {} : { session: toSessionID(source.session) }),
    });

    return { ok: true, connection: makeLocalSendConnection(client, clock) };
  } catch (error) {
    if (error instanceof AtcError && error.code === 'no_daemon') {
      return failed('unreachable', `no daemon at ${source.socketPath}: ${error.message}`);
    }

    if (
      error instanceof AtcError &&
      error.code !== 'internal' &&
      error.code !== 'connection_lost' &&
      error.code !== 'timeout'
    ) {
      return failed(error.code, error.message);
    }

    return failed(
      'unreachable',
      `the daemon at ${source.socketPath} gave no handshake answer: ${describe(error)}`,
    );
  }
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

    return { ok: true, connection: makeRemoteSendConnection(booted.client, clock) };
  } catch (error) {
    if (error instanceof RemoteTokenError) {
      return failed('remote_token', error.message);
    }

    if (error instanceof RemoteDaemonUnreachableError) {
      return failed('unreachable', error.message);
    }

    if (error instanceof AtcError) {
      return failed(error.code, error.message);
    }

    return failed('internal', describe(error));
  }
}

function failed(code: string, message: string): ConnectResult {
  const error: CommandError = { code, message };

  return { ok: false, error };
}

function makeRemoteSendConnection(client: DaemonClient, clock: Clock): SendConnection {
  return makeSendConnection(
    (method, params) => client.sendRequest(method, params),
    { isClosed: () => client.isClosed(), stop: () => client.stop() },
    clock,
  );
}

interface SendHandle {
  readonly isClosed: () => boolean;
  readonly stop: () => void;
}

function makeSendConnection(
  call: <Method extends keyof SendCalls>(
    method: Method,
    params: SendCalls[Method],
  ) => Promise<Readonly<Record<string, unknown>>>,
  handle: SendHandle,
  clock: Clock,
): SendConnection {
  return {
    request: async (method, params, limitMs) => {
      const expired = Promise.withResolvers<never>();

      const cancel = clock.schedule(() => {
        handle.stop();

        expired.reject(
          new AtcError('internal', `no answer to ${method} within ${limitMs / 1000}s`),
        );
      }, limitMs);

      try {
        return await Promise.race([call(method, params), expired.promise]);
      } finally {
        cancel();
      }
    },
    isClosed: handle.isClosed,
    stop: handle.stop,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const LOCAL_CALLS: {
  readonly [Method in keyof SendCalls]: (
    client: AtcClient,
    params: SendCalls[Method],
  ) => Promise<Readonly<Record<string, unknown>>>;
} = {
  'session.list': (client) => client.session.list({}),
  'session.message': (client, params) =>
    client.session.message({ ...params, session: toSessionID(params.session) }),
  'message.get': (client, params) =>
    client.message.get({ ...params, message: toMessageID(params.message) }),
};

function makeLocalSendConnection(client: AtcClient, clock: Clock): SendConnection {
  let closed = false;

  const watchClose = async (): Promise<void> => {
    await client.closed;

    closed = true;
  };

  void watchClose();

  return makeSendConnection(
    (method, params) => LOCAL_CALLS[method](client, params),
    {
      isClosed: () => closed,
      stop: () => {
        void client.close();
      },
    },
    clock,
  );
}
