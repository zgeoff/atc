import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'bun-pty';
import type { IDisposable, IPty } from 'bun-pty';
import { buildStubTUIClaude } from './build-stub-tui-claude';
import { buildStubTUIGrok } from './build-stub-tui-grok';
import { createStubBin } from './create-stub-bin';
import { mergeDeep } from './merge-deep';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

/**
 * One home with the real client running in it under a pseudo-terminal,
 * and the calls that drive and read it.
 */
export type TUIHarness = ReturnType<typeof startTUIHarness>;

const cliPath = join(import.meta.dir, '..', 'cli.ts');

interface TUIHarnessOptions {
  // How long a wait gives the client to draw its first byte; 9 seconds
  // unless set.
  readonly bootMs?: number;
}

/**
 * A fresh home for one run of the real `atc` client in a pseudo-terminal,
 * holding stand-in `claude` and `grok` binaries, which take scenario files
 * dropped into the home, and a config that points at them. `boot` starts
 * the client in the home, which starts its own daemon there; a later `boot`
 * starts a new client on the same home and stops capturing the old one.
 * `read` returns every byte the client drew since the last `reset`, and
 * `waitFor` polls that capture for a needle. The client appends what it
 * decides without drawing to a log: `markClientLog` returns a cursor into
 * it, and `waitForClientLog` polls for a line written after that cursor.
 * `writeConfig` writes the home's config: the stand-in binaries and the git
 * transports the fixture repositories need, with the fields given laid over
 * them. `env` is the environment the client runs with, so a daemon started
 * with it serves the client. A wait made before the client draws anything
 * gets `bootMs` for that first byte. Disposal stops the client and the
 * daemon in the home and removes it. That disposal runs once the current
 * test finishes, so it must run inside a test; disposing sooner runs it
 * then, and a second disposal does nothing.
 */
export function startTUIHarness(options: TUIHarnessOptions = {}) {
  // The client and its daemon stop before their home is removed.
  const owned = new AsyncDisposableStack();

  const dispose = registerTestCleanup(() => owned.disposeAsync());

  // The client boots with this home as its cwd and lists it first in the
  // picker, so the path is resolved the way the client reports it.
  const tmp = owned.use(setupTempDir('atc-tui-'));
  const home = realpathSync(tmp.dir);
  const configPath = join(home, '.config', 'atc', 'config.json');
  const clientLogPath = join(home, 'client.log');
  const fakeClaude = createStubBin(home, 'fake-claude', buildStubTUIClaude());
  const fakeGrok = createStubBin(home, 'fake-grok', buildStubTUIGrok());

  const bootConfig: Readonly<Record<string, unknown>> = {
    claudeBin: fakeClaude,
    claudeArgs: [],
    grokBin: fakeGrok,
    grokArgs: [],

    // No codex binary is written to the home, so the agent picker sees
    // Codex as uninstalled whatever the host machine has.
    codexBin: join(home, 'fake-codex'),
    codexArgs: [],
    gateways: [],

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

  // When the latest client boot wrote its first byte. The client draws
  // nothing until its daemon handshake completes, so that byte is the
  // readiness signal: waits before it get the boot budget, waits after it
  // the interaction budget.
  let firstOutputAt: number | null = null;

  owned.defer(() => stopClientAndDaemon(home, pty, firstOutputAt === null));

  return {
    home,
    configPath,
    env,
    writeConfig,

    boot(): IPty {
      capture?.dispose();

      const booted = spawn(process.execPath, [cliPath], {
        name: 'xterm-256color',
        cols: 110,
        rows: 30,

        // The picker lists the client's own directory first, so a spawn
        // that takes the first entry lands in the home.
        cwd: home,
        env,
      });

      const exit = Promise.withResolvers<number>();

      booted.onExit((event) => {
        exit.resolve(event.exitCode);
      });

      firstOutputAt = null;
      pty = booted;
      exited = exit.promise;

      capture = booted.onData((data) => {
        firstOutputAt ??= Date.now();
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

    async waitFor(needle: string, ms = 4000): Promise<void> {
      const start = Date.now();

      // The client gives its daemon 8 seconds to answer before it draws an
      // error, so the boot phase waits that long plus 1 second for the
      // client's own cold start, which measures under 1.1 seconds on a
      // runner loaded at four times its cores. Every wait after the first
      // byte keeps its own deadline.
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
        { timeoutMs: bootMs, intervalMs: 50 },
      );

      await waitFor(
        () => {
          if (!out.includes(needle)) {
            throw new Error(
              `timed out waiting for ${JSON.stringify(needle)}; tail: ${JSON.stringify(out.slice(-400))}`,
            );
          }
        },
        { timeoutMs: Math.max(0, Math.max(start, firstAt) + ms - Date.now()), intervalMs: 50 },
      );
    },

    waitForExit(): Promise<number> {
      if (exited === null) {
        throw new Error('wait for exit before boot');
      }

      return exited;
    },

    markClientLog(): number {
      return readClientLog(clientLogPath).length;
    },

    async waitForClientLog(line: string, mark: number, ms = 5000): Promise<void> {
      await waitFor(
        () => {
          const written = readClientLog(clientLogPath).slice(mark);

          if (!written.includes(line)) {
            throw new Error(
              `the client log never held ${JSON.stringify(line)} after line ${mark}; it holds ${JSON.stringify(written)} there`,
            );
          }
        },
        { timeoutMs: ms },
      );
    },

    [Symbol.asyncDispose]: dispose,
  };
}

// The client started a daemon inside the home; its pid file is how the
// harness finds and stops it. The daemon writes that file once its modules
// load, so a client killed before its first frame can leave a daemon that
// has not written it yet.
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
