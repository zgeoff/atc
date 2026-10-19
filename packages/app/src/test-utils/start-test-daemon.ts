import { join } from 'node:path';
import { startDaemon } from '@atc/daemon';
import type { DaemonHandle, DaemonOptions } from '@atc/daemon';
import type { DaemonEvent } from '@atc/protocol';
import { openDaemonClient } from '@atc/protocol/client';
import type { DaemonClient } from '@atc/protocol/client';
import {
  assertContractAnswer,
  assertContractEvent,
  registerTestCleanup,
  setupTempDir,
} from '@atc/test-utils';
import type { Socket } from 'bun';
import { buildLocalTarget } from './build-local-target';

interface TestDaemonPaths {
  readonly dir: string;
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

// it runs before every boot, so it may also write files the daemon reads at
// start under the directory.
type TestDaemonOptionsBuilder = (
  paths: TestDaemonPaths,
) => TestDaemonOptions | Promise<TestDaemonOptions>;

interface TestDaemonConfig {
  // The temp directory's name prefix.
  readonly prefix?: string;
  readonly options?: TestDaemonOptionsBuilder;

  // Whether each boot opens the main client; it does unless this is false.
  readonly mainClient?: boolean;
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

type StartedTestDaemon<Config extends TestDaemonConfig> = Config extends {
  readonly mainClient: false;
}
  ? Omit<TestDaemon, 'client' | 'events'>
  : TestDaemon;

// The build string the daemon and every client the harness opens send in
// their handshake.
const BUILD = 'atc/test-build';

export function startTestDaemon<const Config extends TestDaemonConfig = TestDaemonConfig>(
  config?: Config,
): Promise<StartedTestDaemon<Config>>;

export async function startTestDaemon(config: TestDaemonConfig = {}): Promise<TestDaemon> {
  const tmp = setupTempDir(config.prefix ?? 'atc-test-daemon-');

  // Registered after the directory, so it releases first: the daemon stops
  // before its directory is removed.
  const stack = new AsyncDisposableStack();

  const dispose = registerTestCleanup(() => stack.disposeAsync());

  stack.defer(tmp.teardown);

  const paths: TestDaemonPaths = {
    dir: tmp.dir,
    socketPath: join(tmp.dir, 'daemon.sock'),
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    eventsSocketPath: join(tmp.dir, 'events.sock'),
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
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
      client: BUILD,
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

  // An event outside the contract fails the test once the daemon stops. A
  // throw inside the socket's read would drop the lines after the event.
  const contractErrors: string[] = [];

  stack.defer(() => {
    if (contractErrors.length > 0) {
      throw new Error(contractErrors.join('\n'));
    }
  });

  stack.defer(stop);

  const boot = async () => {
    const options = await buildOptions(paths);

    const daemon = await startDaemon({
      log: (line) => {
        logs.push(line);
      },
      ...options,
      targets: options.targets ?? [buildLocalTarget()],
      socketPath: paths.socketPath,
      reporterSocketPath: paths.reporterSocketPath,
      eventsSocketPath: paths.eventsSocketPath,
      dbPath: paths.dbPath,
      statusPath: paths.statusPath,
      build: BUILD,
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

  // A boot that fails stops what it started and removes the directory
  // before the start rejects.
  let current = await boot().catch(async (error: unknown) => {
    await dispose();

    throw error;
  });

  return {
    ...paths,
    build: BUILD,
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

      // A socket write accepts only what fits its buffer, so the rest goes
      // out as the socket drains, and the connection ends once all of it
      // has gone.
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
