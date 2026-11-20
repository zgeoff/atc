import { isRecord } from '@atc/core';
import { openDaemonConnection } from '@atcx/client/connection';
import type { DaemonConnection, DaemonTarget } from '@atcx/client/connection';
import { AtcError } from '@atcx/contract/light';
import type { DaemonClient } from './daemon-client';

// Opens nothing until the hello, so a caller sets its handlers first and picks its hello. The
// hello opens the connection through openDaemonConnection, and a missing daemon fails it with
// no_daemon. Events arrive once the hello is accepted.
export function createDaemonClient(
  address: string | { readonly hostname: string; readonly port: number },
): DaemonClient {
  const target: DaemonTarget = typeof address === 'string' ? { path: address } : address;

  const abort = new AbortController();

  let connection: DaemonConnection | null = null;
  let closed = false;

  const requireConnection = (): DaemonConnection => {
    if (connection === null) {
      throw new AtcError('internal', 'the client has sent no hello yet');
    }

    return connection;
  };

  const client: DaemonClient = {
    onEvent: () => {},
    onClose: () => {},
    onAnswer: () => {},
    principal: undefined,
    get procedures() {
      return requireConnection().procedures;
    },
    isClosed: () => closed,

    sendHello: async (build, options = {}) => {
      const opened = await openDaemonConnection(
        target,
        {
          client: build,
          token: options.token,
          session: options.session,
          principal: options.principal,
          viewer: options.viewer,
        },
        {
          signal: abort.signal,
          onAnswer: (method, answer) => {
            client.onAnswer(method, answer);
          },
        },
      );

      connection = opened;
      void forwardEvents(opened, client);

      void watchClose(opened, () => {
        closed = true;

        client.onClose();
      });

      return { ...opened.hello };
    },

    sendRequest: async (method, params, as, asName) => {
      if (method === 'daemon.hello') {
        return client.sendHello(String(params?.['client']), readHelloOptions(params));
      }

      const principal = as ?? client.principal;

      const answer = await requireConnection().request(method, params, {
        as: principal,
        asName: principal === undefined ? undefined : asName,
      });

      return isRecord(answer) ? answer : {};
    },

    stop: () => {
      closed = true;

      abort.abort(new AtcError('internal', 'client closed'));
      void connection?.close();
    },
  };

  return client;
}

async function forwardEvents(
  connection: DaemonConnection,
  client: Pick<DaemonClient, 'onEvent'>,
): Promise<void> {
  for await (const event of connection.events()) {
    client.onEvent(event);
  }
}

async function watchClose(connection: DaemonConnection, onClose: () => void): Promise<void> {
  await connection.closed;

  onClose();
}

function readHelloOptions(params: Readonly<Record<string, unknown>> | undefined) {
  const auth = params?.['auth'];
  const token = isRecord(auth) ? auth['token'] : undefined;
  const session = params?.['session'];
  const principal = params?.['principal'];
  const viewer = params?.['viewer'];

  return {
    ...(typeof token === 'string' ? { token } : {}),
    ...(typeof session === 'string' ? { session } : {}),
    ...(typeof principal === 'string' ? { principal } : {}),
    ...(typeof viewer === 'string' ? { viewer } : {}),
  };
}
