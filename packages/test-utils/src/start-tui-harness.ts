import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'bun-pty';
import type { IDisposable, IPty } from 'bun-pty';
import { buildStubTUIClaude } from './build-stub-tui-claude';
import { buildStubTUIGrok } from './build-stub-tui-grok';
import { createStubBin } from './create-stub-bin';
import { mergeDeep } from './merge-deep';
import { readSourceEntry } from './read-source-entry';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

export type TUIHarness = ReturnType<typeof startTUIHarness>;

interface TUIHarnessOptions {
  // How long a wait gives the client to draw its first byte; 9 seconds
  // unless set.
  readonly bootMs?: number;

  // The clock the waits read their deadlines from; the wall clock unless
  // set.
  readonly now?: () => number;

  // Waits out the interval between a wait's retries; a real sleep unless
  // set.
  readonly wait?: (delayMs: number) => Promise<void>;
}

// The width the client's terminal opens at. The picker box takes the
// terminal less 4 columns, at most 90, and its input row holds the box less 8.
const COLS = 110;
const INPUT_MAX = Math.min(COLS - 4, 90) - 8;

export function startTUIHarness(options: TUIHarnessOptions = {}) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? Bun.sleep;
  const cliPath = readSourceEntry('atc');
  const temporaryDirectory = setupTempDir('atc-tui-');

  // Registered after the home, so it releases first: the client and its
  // daemon stop before their home is removed.
  const owned = new AsyncDisposableStack();

  const stop = registerTestCleanup(() => owned.disposeAsync());

  owned.defer(temporaryDirectory.teardown);

  // The client boots with this home as its cwd and lists it first in the
  // picker, so the path is resolved the way the client reports it.
  const home = realpathSync(temporaryDirectory.path);
  const configPath = join(home, '.config', 'atc', 'config.json');
  const clientLogPath = join(home, 'client.log');
  const fakeClaude = createStubBin(home, 'fake-claude', buildStubTUIClaude(cliPath));
  const fakeGrok = createStubBin(home, 'fake-grok', buildStubTUIGrok(cliPath));

  const bootConfig: Readonly<Record<string, unknown>> = {
    agents: {
      claude: { kind: 'claude', bin: fakeClaude },
      grok: { kind: 'grok', bin: fakeGrok },

      // No codex binary is written to the home, so the agent picker sees
      // Codex as uninstalled whatever the host machine has.
      codex: { kind: 'codex', bin: join(home, 'fake-codex') },
    },

    // The fixture repositories are local paths and loopback HTTP, which the
    // default transports refuse.
    workspaces: { gitTransports: ['https', 'ssh', 'http', 'file'] },
  };

  const writeConfig = (fields: Readonly<Record<string, unknown>> = {}) => {
    mkdirSync(join(home, '.config', 'atc'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(mergeDeep(bootConfig, fields)));
  };

  writeConfig();

  // A test that drops an executable into the home's bin directory puts it
  // on the PATH of the client and of the daemons it starts.
  const env = {
    ...process.env,
    HOME: home,
    XDG_RUNTIME_DIR: home,
    PATH: `${join(home, 'bin')}:/usr/sbin:/usr/bin:/bin`,
    ATC_CLIENT_LOG: clientLogPath,
  };

  let pty: IPty | null = null;
  let capture: IDisposable | null = null;
  let exited: Promise<number> | null = null;
  let out = '';

  // When the latest client boot wrote its first byte. The client draws nothing
  // before its daemon handshake completes, so waits before that byte get the boot
  // budget, and waits after it their own.
  let firstOutputAt: number | null = null;

  owned.defer(() => stopClientAndDaemon(home, pty, firstOutputAt === null));

  return {
    home,
    configPath,
    env,
    writeConfig,

    // The client drops the head of a text too long for the row, so a wait for
    // typed text under a long temp root still matches.
    formatInput(text: string): string {
      const shown = text.length <= INPUT_MAX ? text : `…${text.slice(-(INPUT_MAX - 1))}`;

      return `> ${shown}`;
    },

    boot(args: readonly string[] = []): IPty {
      capture?.dispose();

      const booted = spawn(process.execPath, [cliPath, ...args], {
        name: 'xterm-256color',
        cols: COLS,
        rows: 30,

        // The picker lists the client's own directory first, so a spawn
        // that takes the first entry lands in the home.
        cwd: home,
        env,
      });

      // Every client a boot starts is killed before the daemon stops, so a
      // client a later boot replaced never outlives the test.
      owned.defer(() => {
        booted.kill();
      });

      const exit = Promise.withResolvers<number>();

      booted.onExit((event) => {
        exit.resolve(event.exitCode);
      });

      firstOutputAt = null;
      pty = booted;
      exited = exit.promise;

      capture = booted.onData((data) => {
        firstOutputAt ??= now();
        out += data;
      });

      return booted;
    },

    write(data: string) {
      if (pty === null) {
        throw new Error('write before boot');
      }

      pty.write(data);
    },

    read(): string {
      return out;
    },

    reset() {
      out = '';
    },

    async waitFor(needle: string, timeoutMs = 4000): Promise<void> {
      const start = now();

      // The client gives its daemon 8 seconds before it draws an error; the extra
      // second covers its own cold start, under 1.1 seconds on a runner loaded at
      // four times its cores.
      const bootMs = options.bootMs ?? 8000 + 1000;

      const firstAt = await waitFor(
        () => {
          if (firstOutputAt === null) {
            throw new Error(
              `timed out waiting for ${JSON.stringify(needle)}; the client wrote nothing in ${bootMs}ms of boot`,
            );
          }

          return firstOutputAt;
        },
        { timeoutMs: bootMs, intervalMs: 50, now, wait },
      );

      await waitFor(
        () => {
          if (!out.includes(needle)) {
            throw new Error(
              `timed out waiting for ${JSON.stringify(needle)}; tail: ${JSON.stringify(out.slice(-400))}`,
            );
          }
        },
        {
          timeoutMs: Math.max(0, Math.max(start, firstAt) + timeoutMs - now()),
          intervalMs: 50,
          now,
          wait,
        },
      );
    },

    waitForExit(): Promise<number> {
      if (exited === null) {
        throw new Error('wait for exit before boot');
      }

      return exited;
    },

    countClientLogLines(): number {
      return readClientLog(clientLogPath).length;
    },

    async waitForClientLog(line: string, mark: number, timeoutMs = 5000): Promise<void> {
      await waitFor(
        () => {
          const written = readClientLog(clientLogPath).slice(mark);

          if (!written.includes(line)) {
            throw new Error(
              `the client log never held ${JSON.stringify(line)} after line ${mark}; it holds ${JSON.stringify(written)} there`,
            );
          }
        },
        { timeoutMs, now, wait },
      );
    },

    stop,
  };
}

// The harness finds the daemon through its pid file, which the daemon writes
// once its modules load, so a client killed before its first frame can leave
// a daemon that has not written it yet.
async function stopClientAndDaemon(home: string, pty: IPty | null, beforeFirstFrame: boolean) {
  pty?.kill();

  const pid = await waitFor(
    () => {
      const read = Number(readFileSync(join(home, 'atc-daemon.pid'), 'utf8'));

      if (!Number.isInteger(read) || read <= 1) {
        throw new Error(`the daemon pid file holds no pid: ${read}`);
      }

      return read;
    },
    { timeoutMs: pty !== null && beforeFirstFrame ? 5000 : 0, intervalMs: 50 },
  ).catch(() => null);

  if (pid === null) {
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {}

  // The next test's cold boot must not share the CPU with this daemon's
  // shutdown, and the daemon must not outlive its home.
  await waitFor(
    () => {
      if (isRunning(pid)) {
        throw new Error(`daemon ${pid} still runs`);
      }
    },
    { timeoutMs: 3000 },
  ).catch(() => {});
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

// The client log's lines, or none before the client writes the file.
function readClientLog(path: string): string[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    return [];
  }
}
