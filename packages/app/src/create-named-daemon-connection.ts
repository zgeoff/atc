import { createHash } from 'node:crypto';
import { formatError } from '@atc/core';
import { createChannelCaller } from '@atc/mcp';
import type { WatchChannel } from '@atc/mcp';
import type { DaemonChannel } from '@atc/protocol/wire';
import { DaemonError } from '@atc/protocol/wire';
import type { DaemonEvent } from '@atcx/contract';
import { createActor } from 'xstate';
import { findEventSessionID } from './find-event-session-id';
import type { MCPDaemonConnection } from './mcp-http-server';
import { pickScopedEvents } from './pick-scoped-events';
import type { ReadFailure, SessionVerdict } from './pick-scoped-events';
import { SCOPED_FORWARDER_MACHINE } from './scoped-forwarder-machine';

// A channel to the named daemon whose handshake has passed, which serves tool
// requests and live terminals alike.
export interface NamedDaemonChannel extends DaemonChannel, WatchChannel {
  principal: string | undefined;
}

interface NamedDaemon {
  readonly name: string;

  // The principal of the config entry, which the daemon's token serves.
  readonly principal: string;
  readonly openChannel: (principal: string) => Promise<NamedDaemonChannel>;
  readonly printError: (line: string) => void;
}

export function createNamedDaemonConnection(daemon: NamedDaemon): MCPDaemonConnection {
  const channels = createChannelCaller(() => daemon.openChannel(daemon.principal));

  return {
    caller: {
      ...channels,
      sendRequest: async (method, params, principal) => {
        const keyed =
          principal === undefined ? params : toConnectorKeyedParams(principal.id, params);

        try {
          return await channels.sendRequest(method, keyed, principal);
        } catch (error) {
          throw toConnectorRefusal(daemon.name, principal?.id ?? null, error);
        }
      },
    },
    openWatchChannel: (principal) =>
      principal === null
        ? daemon.openChannel(daemon.principal)
        : openScopedWatchChannel(daemon, principal),
  };
}

// The daemon keeps every key of a connection under the connection's
// principal, so two connectors that pick the same key would share it.
function toConnectorKeyedParams(
  connector: string,
  params: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const key = params?.['idempotencyKey'];

  if (typeof key !== 'string') {
    return params;
  }

  const hashed = createHash('sha256').update(`${connector}\u0000${key}`).digest('hex');

  return { ...params, idempotencyKey: `connector-${hashed}` };
}

// The daemon's refusal of a connector principal its own config does not list
// names no daemon, and the connector cannot tell which host refused it.
function toConnectorRefusal(daemonName: string, principal: string | null, error: unknown) {
  if (principal === null || !(error instanceof DaemonError) || error.code !== 'unauthorized') {
    return error;
  }

  return new DaemonError(
    'unauthorized',
    `daemon '${daemonName}' refused a request as the connector principal '${principal}': ${error.message}`,
  );
}

// A connection over TCP takes one principal for its events and its output, so
// a second connection as the viewer reports a session that leaves its reach.
async function openScopedWatchChannel(daemon: NamedDaemon, viewer: string): Promise<WatchChannel> {
  const watched = await daemon.openChannel(daemon.principal);

  watched.principal = viewer;

  let reach: NamedDaemonChannel;

  try {
    reach = await daemon.openChannel(viewer);
  } catch (error) {
    watched.stop();
    throw error;
  }

  let closed = false;

  const forwarder = createScopedEventForwarder(
    watched,
    (event) => {
      channel.onEvent(event);
    },
    (failure) => {
      daemon.printError(
        `atc mcp --http: daemon '${daemon.name}' could not read session '${failure.sessionID}' as '${viewer}' for a live terminal, which ended: ${formatError(failure.error)}`,
      );

      close();
    },
  );

  const channel: WatchChannel = {
    onEvent: () => {},
    onClose: () => {},
    procedures: watched.procedures,
    stop: () => {
      forwarder.stop();
      watched.stop();
      reach.stop();
    },
  };

  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;

    channel.stop();
    channel.onClose();
  };

  watched.onEvent = forwarder.onEvent;

  reach.onEvent = (event) => {
    if (event.ev === 'SessionRemoved') {
      channel.onEvent(event);
    }
  };

  watched.onClose = close;
  reach.onClose = close;

  return channel;
}

// The daemon sends the watched connection's events by the entry's reach, and
// the viewer's removal comes over another stream with no shared order, so
// each event waits for a read of its session as the viewer.
interface ScopedEventForwarder {
  readonly onEvent: (event: DaemonEvent) => void;

  // Ends the reads for good, so a read that the closing connection rejects
  // forwards and reports nothing.
  readonly stop: () => void;
}

function createScopedEventForwarder(
  watched: NamedDaemonChannel,
  forward: (event: DaemonEvent) => void,
  onFailure: (failure: ReadFailure) => void,
): ScopedEventForwarder {
  const actor = createActor(SCOPED_FORWARDER_MACHINE).start();

  const removed = new Set<string>();

  let queued: DaemonEvent[] = [];

  const isIn = (state: 'idle' | 'reading' | 'stopped'): boolean =>
    actor.getSnapshot().matches(state);

  const drain = async (): Promise<void> => {
    while (queued.length > 0) {
      const batch = queued;

      queued = [];

      const sessionIDs = [...new Set(batch.map((event) => findEventSessionID(event)))].filter(
        (sessionID): sessionID is string => sessionID !== null && !removed.has(sessionID),
      );

      const verdicts = await Promise.all(
        sessionIDs.map(
          async (sessionID) => [sessionID, await readSessionVerdict(watched, sessionID)] as const,
        ),
      );

      if (isIn('stopped')) {
        return;
      }

      const picked = pickScopedEvents(batch, new Map(verdicts), removed);

      for (const sessionID of picked.removed) {
        removed.add(sessionID);
      }

      for (const event of picked.forward) {
        if (isIn('stopped')) {
          return;
        }

        forward(event);
      }

      if (picked.failure !== null) {
        actor.send({ type: 'STOP' });

        onFailure(picked.failure);

        return;
      }
    }

    actor.send({ type: 'SETTLE' });
  };

  return {
    onEvent: (event) => {
      if (isIn('stopped')) {
        return;
      }

      queued.push(event);

      if (isIn('idle')) {
        actor.send({ type: 'READ' });
        void drain();
      }
    },
    stop: () => {
      actor.send({ type: 'STOP' });

      queued = [];
    },
  };
}

// The codes by which the daemon hides or refuses a session the viewer may not
// read; any other failure leaves the viewer's reach unknown.
const UNREADABLE_CODES: ReadonlySet<string> = new Set([
  'no_such_session',
  'unauthorized',
  'target_forbidden',
]);

async function readSessionVerdict(
  watched: NamedDaemonChannel,
  sessionID: string,
): Promise<SessionVerdict> {
  try {
    await watched.procedures.session.get({ session: sessionID });

    return { kind: 'readable' };
  } catch (error) {
    return error instanceof DaemonError && UNREADABLE_CODES.has(error.code)
      ? { kind: 'unreadable' }
      : { kind: 'failed', error };
  }
}
