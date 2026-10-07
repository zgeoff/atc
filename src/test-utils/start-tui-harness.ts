import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'bun-pty';
import type { IDisposable, IPty } from 'bun-pty';
import { createStubBin } from './create-stub-bin';
import { mergeDeep } from './merge-deep';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

/**
 * The harness `startTUIHarness` returns.
 */
export type TUIHarness = ReturnType<typeof startTUIHarness>;

const repo = join(import.meta.dir, '..', '..');
const cliPath = join(repo, 'src', 'cli.ts');

/**
 * A fresh home for one run of the real `atc` client in a pseudo-terminal,
 * holding fake `claude` and `grok` binaries and a config that points at
 * them. `boot` starts the client in the home, which starts its own daemon
 * there; a later `boot` starts a new client on the same home and stops
 * capturing the old one. `read` returns every byte the client drew since
 * the last `reset`, and `waitFor` polls that capture for a needle. The
 * client appends what it decides without drawing to a log `waitForClientLog`
 * polls. `writeConfig` writes the home's config: the fake binaries and the
 * git transports the fixture repositories need, with the fields given laid
 * over them. `startSourceDaemon` starts a daemon with a fixture source on
 * the home's socket before the client boots, so the client uses it.
 * Disposal stops the client and the daemon in the home and removes it; hold
 * the result with `await using`.
 *
 * The fakes run until killed and take scenario files dropped into the home.
 * Fake `claude` paints `FAKE_CLAUDE_UP args: <its arguments>` at start and
 * on every SIGWINCH, as the real one repaints on a resize, reports
 * `SessionStart` as session `fake-1` with its transcript at
 * `fake-transcript.jsonl`, then a permission `Notification`, and echoes each
 * line it reads as `GOT:<line>`. A `fake-claude-events.jsonl` replaces the
 * notification with its hook lines, and a resumed run waits while
 * `fake-claude-hold-resume` exists before it paints anything. Fake `grok`
 * paints `FAKE_GROK_UP args: <its arguments>`, reports `session_start` as
 * session `fake-grok-1`, then a `permission_prompt` notification, and paints
 * `FAKE_GROK_HOOKS_DONE`. `fake-grok-events.jsonl` replaces the
 * notification with its hook lines, `fake-grok-defer-start` holds the
 * session start while it exists, and `fake-grok-hold-start` skips every
 * report.
 */
export function startTUIHarness() {
  using setup = new DisposableStack();

  // The client boots with this home as its cwd and lists it first in the
  // picker, so the path is resolved the way the client reports it.
  const tmp = setup.use(setupTempDir('atc-tui-'));
  const home = realpathSync(tmp.dir);
  const configPath = join(home, '.config', 'atc', 'config.json');
  const clientLogPath = join(home, 'client.log');
  const fakeClaude = createStubBin(home, 'fake-claude', buildFakeClaude());
  const fakeGrok = createStubBin(home, 'fake-grok', buildFakeGrok());

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

  const owned = new AsyncDisposableStack();

  owned.use(setup.move());
  owned.defer(() => stopClientAndDaemon(home, pty, firstOutputAt === null));

  return {
    home,
    configPath,
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
      const bootMs = 8000 + 1000;

      for (;;) {
        if (out.includes(needle)) {
          return;
        }

        const deadline =
          firstOutputAt === null ? start + bootMs : Math.max(start, firstOutputAt) + ms;

        if (Date.now() >= deadline) {
          break;
        }

        await Bun.sleep(50);
      }

      const detail =
        firstOutputAt === null
          ? `the client wrote nothing in ${bootMs}ms of boot`
          : `tail: ${JSON.stringify(out.slice(-400))}`;

      throw new Error(`timed out waiting for ${JSON.stringify(needle)}; ${detail}`);
    },

    waitForExit(): Promise<number> {
      if (exited === null) {
        throw new Error('wait for exit before boot');
      }

      return exited;
    },

    async waitForClientLog(line: string): Promise<void> {
      await waitFor(() => {
        const lines = readFileSync(clientLogPath, 'utf8').split('\n');

        if (!lines.includes(line)) {
          throw new Error(
            `the client log never held ${JSON.stringify(line)}; it holds ${JSON.stringify(lines)}`,
          );
        }
      });
    },

    async startSourceDaemon(extra: Readonly<Record<string, string>>): Promise<void> {
      const daemon = Bun.spawn(
        [process.execPath, join(repo, 'src', 'test-utils', 'run-source-daemon.ts')],
        {
          env: { ...env, ATC_TEST_SOURCES: 'fixture', ...extra },
          stdout: 'pipe',
          stderr: 'ignore',
        },
      );

      owned.defer(() => {
        daemon.kill();
      });

      const reader = daemon.stdout.getReader();

      await reader.read();

      reader.releaseLock();
    },

    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

function buildFakeClaude(): string {
  return `#!/usr/bin/env bash
ARGS="$*"
case "$ARGS" in *--resume*)
  while [ -f "$HOME/fake-claude-hold-resume" ]; do sleep 0.05; done ;;
esac
paint() { echo "FAKE_CLAUDE_UP args: $ARGS"; }
trap paint WINCH
paint
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | ${buildHookReport()}
if [ -f "$HOME/fake-claude-events.jsonl" ]; then
  while IFS= read -r ev; do
    [ -n "$ev" ] || continue
    sleep 0.3
    printf '%s' "$ev" | ${buildHookReport()}
  done < "$HOME/fake-claude-events.jsonl"
else
  sleep 0.3
  printf '{"hook_event_name":"Notification","session_id":"fake-1","message":"needs permission"}' | ${buildHookReport()}
fi
# bash 3.2 read -t takes whole seconds; a fraction times out immediately
for _ in $(seq 1 300); do
  if read -t 1 -r line; then echo "GOT:$line"; fi
done
`;
}

function buildHookReport(): string {
  return `"${process.execPath}" "${cliPath}" hook-report`;
}

// Grok speaks camelCase envelopes.
function buildFakeGrok(): string {
  return `#!/usr/bin/env bash
ARGS="$*"
paint() { echo "FAKE_GROK_UP args: $ARGS"; }
trap paint WINCH
paint
idle() {
  for _ in $(seq 1 300); do
    if read -t 1 -r line; then echo "GOT:$line"; fi
  done
}
if [ -f "$HOME/fake-grok-hold-start" ]; then
  idle
  exit 0
fi
while [ -f "$HOME/fake-grok-defer-start" ]; do sleep 0.05; done
printf '{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"%s"}' "$PWD" | ${buildHookReport()}
if [ -f "$HOME/fake-grok-events.jsonl" ]; then
  sleep 0.3
  while IFS= read -r ev; do
    [ -n "$ev" ] || continue
    printf '%s' "$ev" | ${buildHookReport()}
    sleep 0.2
  done < "$HOME/fake-grok-events.jsonl"
else
  sleep 0.3
  printf '{"hookEventName":"notification","sessionId":"fake-grok-1","notificationType":"permission_prompt","message":"allow edit?"}' | ${buildHookReport()}
fi
echo "FAKE_GROK_HOOKS_DONE"
idle
`;
}

// The client started a daemon inside the home; its pid file is how the
// harness finds and stops it. The daemon writes that file once its modules
// load, so a client killed before its first frame can leave a daemon that
// has not written it yet.
async function stopClientAndDaemon(home: string, pty: IPty | null, beforeFirstFrame: boolean) {
  pty?.kill();
  const pidPath = join(home, 'atc-daemon.pid');
  const pidDeadline = Date.now() + (pty !== null && beforeFirstFrame ? 5000 : 0);
  let pid = Number.NaN;

  for (;;) {
    try {
      pid = Number(readFileSync(pidPath, 'utf8'));
    } catch {}

    if ((Number.isInteger(pid) && pid > 1) || Date.now() >= pidDeadline) {
      break;
    }

    await Bun.sleep(50);
  }

  if (!Number.isInteger(pid) || pid <= 1) {
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {}

  // The next test's cold boot must not share the CPU with this daemon's
  // shutdown, and the daemon must not outlive its home.
  const exitDeadline = Date.now() + 3000;

  while (Date.now() < exitDeadline) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }

    await Bun.sleep(20);
  }
}
