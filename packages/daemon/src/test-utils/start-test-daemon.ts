import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_TARGET } from '@atc/config';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { openDaemonClient } from '@atc/protocol/client';
import type { DaemonClient } from '@atc/protocol/client';
import { createMigratedStateDB } from '@atc/store/test-utils/create-migrated-state-db';
import type { DaemonEvent } from '@atcx/contract';
import type { Socket } from 'bun';
import type { DaemonHandle } from '../daemon-handle';
import { startDaemon } from '../start-daemon';
import type { DaemonOptions } from '../types';
import { assertContractAnswer } from './assert-contract-answer';
import { assertContractEvent } from './assert-contract-event';
import { buildStubTargets } from './build-stub-targets';

interface TestDaemonPaths {
  readonly directory: string;
  readonly socketPath: string;
  readonly reporterSocketPath: string;
  readonly eventsSocketPath: string;
  readonly dbPath: string;
  readonly statusPath: string;
}

type TestDaemonOptions = Omit<
  DaemonOptions,
  | 'socketPath'
  | 'reporterSocketPath'
  | 'eventsSocketPath'
  | 'dbPath'
  | 'statusPath'
  | 'build'
  | 'targets'
> & { readonly targets?: DaemonOptions['targets'] };

type TestDaemonOptionsBuilder = (
  paths: TestDaemonPaths,
) => TestDaemonOptions | Promise<TestDaemonOptions>;

export interface TestDaemonConfig {
  readonly prefix?: string;
  readonly options?: TestDaemonOptionsBuilder;

  readonly mainClient?: boolean;

  readonly defaultTargets?: () => DaemonOptions['targets'];

  readonly build?: string;
}

interface TestDaemon extends TestDaemonPaths {
  readonly build: string;
  readonly logs: string[];
  readonly events: DaemonEvent[];
  readonly daemon: DaemonHandle;
  readonly client: DaemonClient;
  readonly openClient: (hello?: Readonly<Record<string, unknown>>) => Promise<DaemonClient>;
  readonly openTCPClient: () => Promise<DaemonClient>;
  readonly sendHookLines: (...lines: readonly Readonly<Record<string, unknown>>[]) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly restart: (options?: TestDaemonOptionsBuilder) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export type StartedTestDaemon<Config extends TestDaemonConfig> = Config extends {
  readonly mainClient: false;
}
  ? Omit<TestDaemon, 'client' | 'events'>
  : TestDaemon;

export function startTestDaemon<const Config extends TestDaemonConfig = TestDaemonConfig>(
  config?: Config,
): Promise<StartedTestDaemon<Config>>;

export async function startTestDaemon(config: TestDaemonConfig = {}): Promise<TestDaemon> {
  const temporaryDirectory = setupTempDir(config.prefix ?? 'atc-test-daemon-');
  const build = config.build ?? 'atc/test-build';

  const stack = new AsyncDisposableStack();

  const dispose = registerTestCleanup(() => stack.disposeAsync());

  stack.defer(temporaryDirectory.teardown);

  const paths: TestDaemonPaths = {
    directory: temporaryDirectory.path,
    socketPath: join(temporaryDirectory.path, 'daemon.sock'),
    reporterSocketPath: join(temporaryDirectory.path, 'reporter.sock'),
    eventsSocketPath: join(temporaryDirectory.path, 'events.sock'),
    dbPath: join(temporaryDirectory.path, 'state.db'),
    statusPath: join(temporaryDirectory.path, 'status.json'),
  };

  const logs: string[] = [];
  const events: DaemonEvent[] = [];

  const clients = new Set<DaemonClient>();

  let buildOptions: TestDaemonOptionsBuilder = config.options ?? (() => ({}));
  let live: DaemonHandle | null = null;

  const openClient = async (hello: Readonly<Record<string, unknown>> = {}) => {
    const client = await openDaemonClient(paths.socketPath);

    client.onAnswer = assertContractAnswer;

    clients.add(client);

    await client.sendRequest('daemon.hello', {
      client: build,
      auth: { scheme: 'none' },
      ...hello,
    });

    return client;
  };

  const stop = async () => {
    const stopping = live;

    live = null;

    for (const client of clients) {
      client.stop();
    }

    clients.clear();

    await stopping?.stop();
  };

  // A throw inside the socket's read would drop the lines that follow the event, so errors
  // are collected and thrown after the daemon stops.
  const contractErrors: string[] = [];

  stack.defer(() => {
    if (contractErrors.length > 0) {
      throw new Error(contractErrors.join('\n'));
    }
  });

  stack.defer(stop);

  const boot = async () => {
    const options = await buildOptions(paths);

    if (!existsSync(paths.dbPath)) {
      createMigratedStateDB(paths.dbPath);
    }

    const daemon = await startDaemon({
      log: (line) => {
        logs.push(line);
      },
      ...options,
      targets:
        options.targets ??
        config.defaultTargets?.() ??
        buildStubTargets([LOCAL_TARGET], { spawned: [] }),
      socketPath: paths.socketPath,
      reporterSocketPath: paths.reporterSocketPath,
      eventsSocketPath: paths.eventsSocketPath,
      dbPath: paths.dbPath,
      statusPath: paths.statusPath,
      build,
    });

    live = daemon;

    if (config.mainClient === false) {
      return { daemon, client: null };
    }

    const client = await openClient();

    client.onEvent = (event) => {
      events.push(event);

      try {
        assertContractEvent(event);
      } catch (error) {
        contractErrors.push(String(error));
      }
    };

    return { daemon, client };
  };

  let current = await boot().catch(async (error: unknown) => {
    await dispose();

    throw error;
  });

  return {
    ...paths,
    build,
    logs,
    events,
    get daemon(): DaemonHandle {
      return current.daemon;
    },
    get client(): DaemonClient {
      if (current.client === null) {
        throw new Error('the test daemon started without a main client');
      }

      return current.client;
    },
    openClient,
    async openTCPClient(): Promise<DaemonClient> {
      const port = current.daemon.listenPort;

      if (port === null) {
        throw new Error('the test daemon started without a TCP listener');
      }

      const client = await openDaemonClient({ hostname: '127.0.0.1', port });

      client.onAnswer = assertContractAnswer;

      clients.add(client);

      return client;
    },
    async sendHookLines(...lines: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      const payload = Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
      const closed = Promise.withResolvers<void>();
      let sent = 0;

      // A socket write accepts only what fits its buffer and drops the rest, so the remainder
      // must wait for the drain event.
      const sendRemainder = (socket: Socket) => {
        sent += socket.write(payload.subarray(sent));

        if (sent === payload.length) {
          socket.end();
        }
      };

      await Bun.connect({
        unix: paths.reporterSocketPath,
        socket: {
          open: sendRemainder,
          drain: sendRemainder,
          close() {
            closed.resolve();
          },
          data() {},
          error() {},
        },
      });

      await closed.promise;
    },
    stop,
    async restart(options: TestDaemonOptionsBuilder = buildOptions): Promise<void> {
      await stop();

      buildOptions = options;

      current = await boot();
    },
    dispose,
  };
}
