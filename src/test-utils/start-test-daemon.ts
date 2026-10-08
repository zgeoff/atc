import { join } from 'node:path';
import type { Socket } from 'bun';
import { DaemonClient } from '../client/daemon-client';
import { startDaemon } from '../daemon/daemon';
import type { DaemonHandle, DaemonOptions } from '../daemon/daemon';
import type { EventMsg } from '../protocol/protocol';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';

/**
 * Where a test daemon keeps its sockets and state, all inside one temp
 * directory, so the daemon's lock and record files land there too.
 */
interface TestDaemonPaths {
  readonly dir: string;
  readonly socketPath: string;
  readonly reporterSocketPath: string;
  readonly eventsSocketPath: string;
  readonly dbPath: string;
  readonly statusPath: string;
}

/**
 * Every daemon option except the paths and the build string, which the
 * harness owns.
 */
type TestDaemonOptions = Omit<
  DaemonOptions,
  'socketPath' | 'reporterSocketPath' | 'eventsSocketPath' | 'dbPath' | 'statusPath' | 'build'
>;

/**
 * Builds the options for one boot from the daemon's paths. It runs before
 * every boot, so it may also write what the daemon reads at start, such as
 * a token file or a fake agent binary under the directory.
 */
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

/**
 * A running test daemon and the calls that drive it.
 */
interface TestDaemon extends TestDaemonPaths {
  readonly build: string;
  readonly logs: string[];
  readonly events: EventMsg[];
  readonly daemon: DaemonHandle;
  readonly client: DaemonClient;
  readonly openClient: (hello?: Readonly<Record<string, unknown>>) => Promise<DaemonClient>;
  readonly openTCPClient: () => Promise<DaemonClient>;
  readonly sendHookLines: (...lines: readonly Readonly<Record<string, unknown>>[]) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly restart: (options?: TestDaemonOptionsBuilder) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

/**
 * The harness a config starts: one that opens no main client has neither
 * that client nor the events it would collect.
 */
type StartedTestDaemon<Config extends TestDaemonConfig> = Config extends {
  readonly mainClient: false;
}
  ? Omit<TestDaemon, 'client' | 'events'>
  : TestDaemon;

// The build string the daemon and every client the harness opens send in
// their handshake.
const BUILD = 'atc/test-build';

/**
 * A real daemon in a fresh temp directory, with a main client that has
 * already sent its handshake unless the config turns that client off, which
 * leaves every connection the daemon counts to the test. The options
 * builder chooses what the daemon wires; the harness sets the paths and the
 * build, and collects the daemon's log lines unless the options set their
 * own log. `events` collects every event the main client receives, across
 * restarts. `openClient` opens another client over the unix socket and
 * sends its handshake with the given params; `openTCPClient` connects to
 * the TCP listener and sends nothing, so the test drives that handshake
 * itself. `sendHookLines` writes reporter lines to the reporter socket and
 * resolves once the daemon has closed the connection. `stop` closes every
 * client and stops the daemon; `restart` does the same, then boots on the
 * same paths and state with the options given or the last ones, and opens
 * a new main client unless the config turns it off. `dispose` stops what is
 * running and removes the directory. It runs once the current test
 * finishes, so the harness must start inside a test; calling it sooner runs
 * it then, and a second call does nothing. A first boot that fails runs it
 * before the start rejects.
 */
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
  const events: EventMsg[] = [];

  const clients = new Set<DaemonClient>();

  let buildOptions: TestDaemonOptionsBuilder = config.options ?? (() => ({}));
  let live: DaemonHandle | null = null;

  const openClient = async (hello: Readonly<Record<string, unknown>> = {}) => {
    const client = await DaemonClient.open(paths.socketPath);

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

  stack.defer(stop);

  const boot = async () => {
    const options = await buildOptions(paths);

    const daemon = await startDaemon({
      log: (line) => {
        logs.push(line);
      },
      ...options,
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

      const client = await DaemonClient.open({ hostname: '127.0.0.1', port });

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
      // oxlint-disable-next-line prefer-readonly-parameter-types -- a socket is a live handle
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
