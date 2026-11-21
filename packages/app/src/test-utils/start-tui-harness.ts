import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config';
import { readSourceEntry } from '@atc/core/test-utils/read-source-entry';
import { writeStubProgram } from '@atc/core/test-utils/write-stub-program';
import { Terminal } from '@xterm/headless';
import { mergeDeep } from '@zgeoff/std';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import { spawn } from 'bun-pty';
import type { IDisposable, IPty } from 'bun-pty';
import { buildStubTUIClaude } from './build-stub-tui-claude';
import { buildStubTUIGrok } from './build-stub-tui-grok';

export type TUIHarness = ReturnType<typeof startTUIHarness>;

interface TUIHarnessOptions {
  readonly createStateDB: (dbPath: string) => void;

  readonly bootMs?: number;

  // the terminal's size, 110 by 30 when left out
  readonly cols?: number;
  readonly rows?: number;

  readonly now?: () => number;

  readonly wait?: (delayMs: number) => Promise<void>;
}

const DEFAULT_COLS = 110;
const DEFAULT_ROWS = 30;

export function startTUIHarness(options: TUIHarnessOptions) {
  const COLS = options.cols ?? DEFAULT_COLS;
  const ROWS = options.rows ?? DEFAULT_ROWS;

  // The picker box takes the terminal width less 4 columns, at most 90, and its input row holds
  // the box less 8, so at the default width the box is 90 columns and the input row 82.
  const INPUT_MAX = Math.min(COLS - 4, 90) - 8;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? Bun.sleep;
  const cliPath = readSourceEntry('atc');
  const temporaryDirectory = createTempDir('atc-tui-');

  // The stack releases in reverse order, so the client and its daemon, deferred after the
  // home, stop before their home is removed.
  const owned = new AsyncDisposableStack();

  const stop = registerTestCleanup(() => owned.disposeAsync());

  owned.defer(temporaryDirectory.remove);

  // The client boots with this home as its cwd and lists it first in the
  // picker, so the path is resolved the way the client reports it.
  const home = realpathSync(temporaryDirectory.path);
  const configPath = join(home, '.config', 'atc', 'config.json');
  const clientLogPath = join(home, 'client.log');
  const fakeClaude = writeStubProgram(home, 'fake-claude', buildStubTUIClaude(cliPath));
  const fakeGrok = writeStubProgram(home, 'fake-grok', buildStubTUIGrok(cliPath));

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

  const env = {
    ...process.env,
    HOME: home,
    XDG_RUNTIME_DIR: home,
    PATH: `${join(home, 'bin')}:/usr/sbin:/usr/bin:/bin`,
    ATC_CLIENT_LOG: clientLogPath,
  };

  const paths = resolvePaths(env);

  writeConfig();
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });

  options.createStateDB(paths.dbFile);

  let pty: IPty | null = null;
  let capture: IDisposable | null = null;
  let exited: Promise<number> | null = null;
  let out = '';
  let screen: Terminal | null = null;
  let screenWrites: Promise<void> = Promise.resolve();

  // The client draws nothing until its daemon handshake completes, so a wait that starts
  // before the first byte of the latest boot gets the boot budget; later waits get their own.
  let firstOutputAt: number | null = null;

  owned.defer(() => stopClientAndDaemon(paths.daemonPidFile, pty, firstOutputAt === null));

  return {
    home,
    configPath,
    env,
    paths,
    writeConfig,

    // The client drops the head of a text too long for the row, so a wait for
    // typed text under a long temp root still matches.
    formatInput(text: string): string {
      const shown = text.length <= INPUT_MAX ? text : `…${text.slice(-(INPUT_MAX - 1))}`;

      return `> ${shown}`;
    },

    boot(args: readonly string[] = []): IPty {
      capture?.dispose();
      screen?.dispose();

      screen = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });

      const booted = spawn(process.execPath, [cliPath, ...args], {
        name: 'xterm-256color',
        cols: COLS,
        rows: ROWS,

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

        screenWrites = new Promise<void>((resolve) => {
          screen?.write(data, resolve);
        });
      });

      return booted;
    },

    write(data: string) {
      if (pty === null) {
        throw new Error('write before boot');
      }

      pty.write(data);
    },

    // The client draws only the cells that changed, so the text a screen shows is not all in the
    // output. This gives the output, then the text of the screen the output draws.
    read(): string {
      return `${out}\n${readScreenText(screen)}`;
    },

    // The text of the screen alone, with no output before it. A check that a panel has left the
    // screen reads this, since the output still holds the panel's last frames.
    readScreen(): string {
      return readScreenText(screen);
    },

    reset() {
      out = '';
    },

    // Also blanks the screen text, for a check that the client draws a cell again. A new terminal
    // empties it at once, and no queued write lands on it.
    resetScreen() {
      out = '';
      screen?.dispose();

      screen = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });

      screenWrites = Promise.resolve();
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
        { timeoutMs: bootMs, intervalMs: 50, now, sleep: wait },
      );

      await waitFor(
        () => {
          if (!out.includes(needle) && !readScreenText(screen).includes(needle)) {
            throw new Error(
              `timed out waiting for ${JSON.stringify(needle)}; tail: ${JSON.stringify(out.slice(-400))}`,
            );
          }
        },
        {
          timeoutMs: Math.max(0, Math.max(start, firstAt) + timeoutMs - now()),
          intervalMs: 50,
          now,
          sleep: wait,
        },
      );

      await screenWrites;
    },

    // Waits until the screen no longer shows the text, such as the border of a panel that fades out.
    // A screen that a reset just blanked shows nothing, so wait for what replaces the text first.
    async waitForGone(needle: string, timeoutMs = 4000): Promise<void> {
      await waitFor(
        async () => {
          await screenWrites;

          if (readScreenText(screen).includes(needle)) {
            throw new Error(`timed out waiting for ${JSON.stringify(needle)} to leave the screen`);
          }
        },
        { timeoutMs, intervalMs: 50, now, sleep: wait },
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
        { timeoutMs, now, sleep: wait },
      );
    },

    stop,
  };
}

// The harness finds the daemon through its pid file, which the daemon writes
// once its modules load, so a client killed before its first frame can leave
// a daemon that has not written it yet.
async function stopClientAndDaemon(pidFile: string, pty: IPty | null, beforeFirstFrame: boolean) {
  pty?.kill();

  const readPid = (): number => {
    const read = Number(readFileSync(pidFile, 'utf8'));

    if (!Number.isInteger(read) || read <= 1) {
      throw new Error(`the daemon pid file holds no pid: ${read}`);
    }

    return read;
  };

  // A client that never booted wrote no pid file, so only a boot still in flight is worth a wait.
  const pid =
    pty !== null && beforeFirstFrame
      ? await waitFor(readPid, { timeoutMs: 5000, intervalMs: 50 }).catch(() => null)
      : readPidOrNull(readPid);

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

function readPidOrNull(readPid: () => number): number | null {
  try {
    return readPid();
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function readScreenText(screen: Terminal | null): string {
  if (screen === null) {
    return '';
  }

  const lines: string[] = [];

  for (let row = 0; row < screen.rows; row++) {
    lines.push(screen.buffer.active.getLine(row)?.translateToString(true) ?? '');
  }

  return lines.join('\n');
}

// The client creates this file only when it first writes to its log, so a missing file means no
// lines yet.
function readClientLog(path: string): string[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    return [];
  }
}
