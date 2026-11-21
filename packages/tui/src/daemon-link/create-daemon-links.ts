import type { AgentID } from '@atc/core';
import { formatError } from '@atc/core';
import type { DaemonBoot } from '@atc/protocol';
import type { DaemonClient } from '@atc/protocol/client';
import { createDaemonTransport } from '@atc/protocol/wire/transport';
import type { DaemonTransport } from '@atc/protocol/wire/transport';
import type { DaemonEvent } from '@atcx/contract';
import type { Clock } from '@zgeoff/std';
import type { TUIDaemon } from '../client/tui-host';
import type { FleetMirror } from '../fleet/create-fleet-mirror';
import type { DaemonName } from '../fleet/session-key';
import { DaemonLinkFailureError } from './daemon-link-failure-error';
import type { DaemonLinkState } from './daemon-link-state';

// A token fix or an upgrade of the remote daemon heals a refused link without a client restart.
const REFUSAL_RETRY_MS = 30_000;

export interface DaemonLinksDeps {
  readonly daemons: readonly TUIDaemon[];
  readonly clock: Pick<Clock, 'now' | 'schedule'>;
  readonly mirror: Pick<FleetMirror, 'refresh'>;
  readonly onEvent: (daemon: DaemonName, event: DaemonEvent) => void;

  readonly readAgents: (daemon: DaemonName, client: DaemonClient) => Promise<void>;
  readonly logEvent: (line: string) => void;
}

export interface DaemonLinks {
  readonly clientFor: (daemon: DaemonName) => DaemonClient | null;
  readonly stateOf: (daemon: DaemonName) => DaemonLinkState;
  readonly onChange: (listener: (daemon: DaemonName, state: DaemonLinkState) => void) => void;

  readonly upDaemons: () => readonly DaemonName[];

  readonly lastUsedAgent: (daemon: DaemonName) => AgentID | null;

  readonly listDaemons: () => readonly DaemonName[];

  readonly setPrimary: (state: DaemonLinkState, boot?: DaemonBoot) => void;

  readonly openRemotes: () => void;
  readonly stop: () => void;
}

interface RemoteLink {
  readonly boot: DaemonBoot;
}

interface LinkRecord {
  state: DaemonLinkState;
  boot: DaemonBoot | null;
}

export function createDaemonLinks(deps: DaemonLinksDeps): DaemonLinks {
  const primary = deps.daemons[0]?.name ?? null;

  const records = new Map<DaemonName, LinkRecord>();

  const listeners: ((daemon: DaemonName, state: DaemonLinkState) => void)[] = [];
  const transports: DaemonTransport<RemoteLink>[] = [];
  let stopped = false;

  for (const daemon of deps.daemons) {
    records.set(daemon.name, { state: { kind: 'connecting' }, boot: null });
  }

  const getRecord = (daemon: DaemonName): LinkRecord => {
    const record = records.get(daemon);

    if (record === undefined) {
      throw new Error(`no link for daemon ${daemon ?? 'local'}`);
    }

    return record;
  };

  const setState = (daemon: DaemonName, state: DaemonLinkState) => {
    const record = getRecord(daemon);
    const before = record.state;

    record.state = state;

    const same =
      before.kind === state.kind &&
      (before.kind === 'up' ||
        before.kind === 'connecting' ||
        ('detail' in state && before.detail === state.detail));

    if (!same) {
      for (const listener of listeners) {
        listener(daemon, state);
      }
    }
  };

  const sleep = async (durationMs: number) => {
    const rested = Promise.withResolvers<void>();

    deps.clock.schedule(rested.resolve, durationMs);

    await rested.promise;
  };

  const openRemote = (daemon: TUIDaemon & { readonly name: string }) => {
    const name = daemon.name;

    // A refusal waits out its own retry inside the open, so each retry boots again and reads the token again.
    const open = async (): Promise<RemoteLink> => {
      for (;;) {
        try {
          return { boot: await daemon.bootDaemon({ clock: deps.clock }) };
        } catch (error) {
          if (!(error instanceof DaemonLinkFailureError) || error.kind === 'down') {
            throw error;
          }

          setState(name, { kind: error.kind, detail: error.message });

          await sleep(REFUSAL_RETRY_MS);

          if (stopped) {
            throw error;
          }
        }
      }
    };

    const transport: DaemonTransport<RemoteLink> = createDaemonTransport<RemoteLink>({
      reconnect: 'always',
      backoffMs: [0, 200, 1000, 2000],
      clock: deps.clock,
      getConnection: (link) => link.boot.client.connection,
      open,
      onReady: (link) => {
        const client = link.boot.client;

        getRecord(name).boot = link.boot;

        client.onEvent = (event) => {
          deps.onEvent(name, event);
        };

        void (async () => {
          try {
            await deps.mirror.refresh(name, client);
            await deps.readAgents(name, client);
          } catch (error) {
            if (!client.isClosed()) {
              deps.logEvent(`daemon ${name}: ${formatError(error)}`);

              setState(name, { kind: 'down', detail: formatError(error) });

              transport.stopConnection(link);
            }

            return;
          }

          if (transport.findLatest() === link && !transport.isLost(link)) {
            setState(name, { kind: 'up' });
          }
        })();
      },
      onLost: () => {
        setState(name, { kind: 'down', detail: 'the connection dropped' });
      },
      onOpenFailed: (error) => {
        setState(name, { kind: 'down', detail: formatError(error) });

        deps.logEvent(`daemon ${name}: ${formatError(error)}; trying again`);
      },
    });

    transports.push(transport);

    // The transport retries every failure, so this wait ends only when the link opens or stops.
    void (async () => {
      try {
        await transport.waitForConnection();
      } catch {}
    })();
  };

  return {
    clientFor: (daemon) => {
      const record = getRecord(daemon);

      return record.state.kind === 'up' && record.boot !== null ? record.boot.client : null;
    },
    stateOf: (daemon) => getRecord(daemon).state,

    onChange: (listener) => {
      listeners.push(listener);
    },

    upDaemons: () =>
      deps.daemons
        .map((daemon) => daemon.name)
        .filter((name) => getRecord(name).state.kind === 'up'),

    lastUsedAgent: (daemon) => getRecord(daemon).boot?.lastUsedAgent ?? null,
    listDaemons: () => deps.daemons.map((daemon) => daemon.name),

    setPrimary: (state, boot) => {
      if (boot !== undefined) {
        getRecord(primary).boot = boot;
      }

      setState(primary, state);
    },

    openRemotes: () => {
      for (const daemon of deps.daemons) {
        if (daemon.name !== null && daemon.name !== primary) {
          openRemote({ ...daemon, name: daemon.name });
        }
      }
    },

    stop: () => {
      stopped = true;

      for (const transport of transports) {
        transport.stop();
      }
    },
  };
}
