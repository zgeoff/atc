import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { spawn } from 'bun-pty';
import type { IPty } from 'bun-pty';
import { DaemonClient } from '../src/client/daemon-client';
import { isRecord } from '../src/shared/report';
import { startGitHTTPServer } from './start-git-http-server';

const repo = join(import.meta.dir, '..');
const CTRL_SPACE = String.fromCodePoint(0);
const BEL = String.fromCodePoint(7);

function collectEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return { ...env, ...extra };
}

interface TestContext {
  home: string;
  boot: () => IPty;
  read: () => string;
  reset: () => void;
  waitFor: (needle: string, ms?: number) => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

// The transports the fixture upstreams are reached over: local paths, and
// smart HTTP on the loopback.
const FIXTURE_GIT_TRANSPORTS = ['https', 'ssh', 'http', 'file'];

function setupTest(): TestContext {
  // The client boots with this home as its cwd and lists it first in the
  // picker, so the path is resolved the way the client reports it.
  const tempHome = mkdtempSync(join(tmpdir(), 'atc-test-'));
  const home = realpathSync(tempHome);

  mkdirSync(join(home, '.config', 'atc'), { recursive: true });

  const fakeClaude = join(home, 'fake-claude');
  const fakeGrok = join(home, 'fake-grok');
  const hookReport = `"${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report`;

  // Like real Claude Code, the fake repaints its screen on SIGWINCH — the
  // attach jiggle depends on exactly that behavior for replay. Drop
  // fake-claude-delay-resume to make a resumed run paint a second late.
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
ARGS="$*"
paint() { echo "FAKE_CLAUDE_UP args: $ARGS"; }
trap paint WINCH
if [ -f "$HOME/fake-claude-delay-resume" ]; then
  case "$ARGS" in *--resume*) sleep 1 ;; esac
fi
paint
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | ${hookReport}
sleep 0.3
printf '{"hook_event_name":"Notification","session_id":"fake-1","message":"needs permission"}' | ${hookReport}
# bash 3.2 read -t takes whole seconds; a fraction times out immediately
for _ in $(seq 1 300); do
  if read -t 1 -r line; then echo "GOT:$line"; fi
done
`,
    { mode: 0o755 },
  );

  // Grok speaks camelCase envelopes. Drop fake-grok-hold-start to skip
  // SessionStart, fake-grok-delay-start to send it a second late, or
  // fake-grok-events.jsonl to replace the default permission_prompt with
  // extra hook lines.
  writeFileSync(
    fakeGrok,
    `#!/usr/bin/env bash
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
if [ -f "$HOME/fake-grok-delay-start" ]; then
  sleep 1
fi
printf '{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"%s"}' "$PWD" | ${hookReport}
if [ -f "$HOME/fake-grok-events.jsonl" ]; then
  sleep 0.3
  while IFS= read -r ev; do
    [ -n "$ev" ] || continue
    printf '%s' "$ev" | ${hookReport}
    sleep 0.2
  done < "$HOME/fake-grok-events.jsonl"
else
  sleep 0.3
  printf '{"hookEventName":"notification","sessionId":"fake-grok-1","notificationType":"permission_prompt","message":"allow edit?"}' | ${hookReport}
fi
echo "FAKE_GROK_HOOKS_DONE"
idle
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      claudeBin: fakeClaude,
      claudeArgs: [],
      grokBin: fakeGrok,
      grokArgs: [],

      // No codex binary is written to the temp home, so the agent picker
      // sees Codex as uninstalled whatever the host machine has.
      codexBin: join(home, 'fake-codex'),
      codexArgs: [],
      gateways: [],
      workspaces: { gitTransports: FIXTURE_GIT_TRANSPORTS },
    }),
  );

  let pty: IPty | null = null;
  let out = '';

  // When the latest client boot wrote its first byte. The client draws
  // nothing until its daemon handshake completes, so that byte is the
  // readiness signal: waits before it get the boot budget, waits after it
  // the interaction budget.
  let firstOutputAt: number | null = null;

  return {
    home,

    boot() {
      pty = spawn(process.execPath, [join(repo, 'src', 'cli.ts')], {
        name: 'xterm-256color',
        cols: 110,
        rows: 30,

        // The picker lists the client's own directory first, so a spawn
        // that takes the first entry lands in this test's home.
        cwd: home,

        // A test that drops an executable into the home's bin directory
        // puts it on the PATH of the client and the daemon it starts.
        env: collectEnv({
          HOME: home,
          XDG_RUNTIME_DIR: home,
          PATH: `${join(home, 'bin')}:/usr/sbin:/usr/bin:/bin`,
        }),
      });

      firstOutputAt = null;

      pty.onData((d) => {
        firstOutputAt ??= Date.now();
        out += d;
      });

      return pty;
    },

    read() {
      return out;
    },

    reset() {
      out = '';
    },

    async waitFor(needle: string, ms = 4000) {
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

    async [Symbol.asyncDispose]() {
      pty?.kill();

      // The client auto-spawned a daemon inside this test's HOME; its pid
      // file is how the harness finds and stops it. The daemon writes that
      // file once its modules load, so a client killed before its first
      // frame can leave a daemon that has not written it yet.
      const pidPath = join(home, 'atc-daemon.pid');
      const pidDeadline = Date.now() + (pty !== null && firstOutputAt === null ? 5000 : 0);
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

      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}

        // The next test's cold boot must not share the CPU with this
        // daemon's shutdown, and the daemon must not outlive its home.
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

      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function spawnSession(ctx: TestContext, pty: IPty, name: string) {
  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

  ctx.reset();
  pty.write(`${name}\r`);

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('FAKE_CLAUDE_UP');
}

async function spawnGrokSession(ctx: TestContext, pty: IPty, name: string) {
  pty.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.reset();
  pty.write('\u001B[B');

  await ctx.waitFor('\u001B[7mGrok');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

  ctx.reset();
  pty.write(`${name}\r`);

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('FAKE_GROK_UP');
}

// A bare repository under the home with one commit on main, made by git
// commands that read neither the host's system nor its global git config.
async function createFixtureUpstream(home: string) {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'atc',
    GIT_AUTHOR_EMAIL: 'atc@example.com',
    GIT_COMMITTER_NAME: 'atc',
    GIT_COMMITTER_EMAIL: 'atc@example.com',
  };

  const upstream = join(home, 'upstream.git');
  const work = join(home, 'upstream-work');

  await $`git init --quiet --bare --template= --initial-branch=main ${upstream}`.env(env).quiet();
  await $`git clone --quiet --template= ${upstream} ${work}`.env(env).quiet();

  writeFileSync(join(work, 'README.md'), 'hello\n');

  await $`git add README.md`.env(env).cwd(work).quiet();
  await $`git commit --quiet --no-gpg-sign -m initial`.env(env).cwd(work).quiet();
  await $`git push --quiet origin main`.env(env).cwd(work).quiet();

  const sha = await $`git rev-parse HEAD`
    .env(env)
    .cwd(work)
    .text()
    .then((text) => text.trim());

  return { env, upstream, work, sha };
}

// Puts a fake gh first on the PATH of the client and its daemon, so no test
// reaches a real gh or GitHub. The default fake is signed out.
function writeFakeGH(home: string, script = "#!/bin/sh\necho 'gh auth login' >&2\nexit 4\n") {
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'gh'), script, { mode: 0o755 });
}

// A fake gh whose repository listing answers 1.5 seconds after it starts.
const SLOW_GH = `#!/bin/sh
case "$1" in
  config) echo https ;;
  *) sleep 1.5; echo '[{"nameWithOwner":"me/dots","description":"dotfiles","isPrivate":false,"url":"https://github.com/me/dots","sshUrl":"git@github.com:me/dots.git"}]' ;;
esac
`;

// Opens the GitHub repository step of a Claude spawn.
async function openRepoStep(ctx: TestContext, pty: IPty) {
  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  pty.write('\t');

  await ctx.waitFor('spawn: GitHub repository');
}

async function waitForStatus(statusPath: string, needle: string) {
  const start = Date.now();

  while (Date.now() - start < 4000) {
    const rawStatus = await Bun.file(statusPath)
      .text()
      .catch(() => '');

    if (rawStatus.includes(needle)) {
      return;
    }

    await Bun.sleep(50);
  }

  throw new Error(`status.json never contained ${needle}`);
}

test('it surfaces a needs-you session in the overlay and kills it on confirm', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'testsess');

  expect(ctx.read()).toInclude('--settings');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');
  await ctx.waitFor('need you: testsess');

  pty.write('K');

  await ctx.waitFor('kill selected session?');

  pty.write('y');

  await Bun.sleep(300); // the kill has no on-screen marker to wait for before quitting

  let exited = false;

  pty.onExit(() => {
    exited = true;
  });

  pty.write('q');

  await Bun.sleep(500); // quit tears the process down; only the exit event observes it

  expect(exited).toBe(true);
}, 15_000);

test('it clears the need state when attaching a needy session', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'needytest');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');

  pty.write('\r');

  const statusPath = join(ctx.home, '.local', 'state', 'atc', 'status.json');
  const start = Date.now();
  let cleared = false;

  while (Date.now() - start < 3000) {
    const rawStatus = await Bun.file(statusPath)
      .text()
      .catch(() => '');

    if (rawStatus.includes('"needs_you":0')) {
      cleared = true;
      break;
    }

    await Bun.sleep(50);
  }

  expect(cleared).toBe(true);
});

test('it narrows the overlay to sessions matching the slash filter', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'alpha');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');

  pty.write('\r'); // attach alpha so it stops being the urgent session in the status bar

  await Bun.sleep(200); // the attach repaint has no unique marker to wait for

  ctx.reset();
  pty.write(CTRL_SPACE);

  await ctx.waitFor('sessions');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

  pty.write('bravo\r');

  await ctx.waitFor('spawn: initial prompt');

  pty.write('\r');

  await ctx.waitFor('FAKE_CLAUDE_UP');

  ctx.reset();
  pty.write(CTRL_SPACE);

  await ctx.waitFor('bravo');

  pty.write('/');

  await ctx.waitFor('type to filter');

  ctx.reset();
  pty.write('brav');

  await ctx.waitFor('/ brav');
  await ctx.waitFor('bravo');

  expect(ctx.read()).not.toInclude('alpha        ');
});

test('it opens the overlay with a configured leader key', async () => {
  await using ctx = setupTest();

  writeFileSync(
    join(ctx.home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      claudeBin: join(ctx.home, 'fake-claude'),
      claudeArgs: [],
      grokBin: join(ctx.home, 'fake-grok'),
      grokArgs: [],
      leader: 'ctrl-]',
    }),
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  expect(ctx.read()).toInclude('^]');

  await spawnSession(ctx, pty, 'leadertest');

  ctx.reset();
  pty.write('\u001D');

  await ctx.waitFor('leadertest');
  await ctx.waitFor('sessions');
});

test('it jumps to the most urgent needs-you session on tab', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'needy');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');

  pty.write('\r'); // attach needy, clearing its need

  await Bun.sleep(200); // the attach repaint has no unique marker to wait for

  ctx.reset();
  pty.write(CTRL_SPACE);

  await ctx.waitFor('sessions');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

  pty.write('urgent\r');

  await ctx.waitFor('spawn: initial prompt');

  pty.write('\r');

  await ctx.waitFor('FAKE_CLAUDE_UP');

  // The freshly spawned session goes needs-you on its own notification,
  // observable through the statusline contract file while attached.
  const statusPath = join(ctx.home, '.local', 'state', 'atc', 'status.json');

  await waitForStatus(statusPath, '"needs_you":1');

  ctx.reset();
  pty.write(CTRL_SPACE);

  await ctx.waitFor('sessions');

  pty.write('\u0009');

  // Tab attaches the needy session and attaching acks it.
  await waitForStatus(statusPath, '"needs_you":0');
}, 15_000);

test('it tab-jumps to a finished session when none need you', async () => {
  await using ctx = setupTest();

  // This fake reports a finished turn instead of a notification, so its
  // session lands done with nothing needing you. It idles in short sleeps so
  // the repaint trap stays responsive to the attach jiggle.
  writeFileSync(
    join(ctx.home, 'fake-claude'),
    `#!/usr/bin/env bash
paint() { echo "FAKE_CLAUDE_UP"; }
trap paint WINCH
paint
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | "${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report
sleep 0.3
printf '{"hook_event_name":"Stop","session_id":"fake-1"}' | "${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report
for _ in $(seq 1 300); do sleep 0.1; done
`,
    { mode: 0o755 },
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'finished');

  const statusPath = join(ctx.home, '.local', 'state', 'atc', 'status.json');

  await waitForStatus(statusPath, '"done":1');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('sessions');

  ctx.reset();
  pty.write('\u0009');

  // Tab attaches the finished session: the attach jiggle repaints the fake,
  // whose marker only reaches the screen while attached.
  await ctx.waitFor('FAKE_CLAUDE_UP');
}, 15_000);

test('it pins a session from the overlay and marks its row', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'pinme');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');

  ctx.reset();
  pty.write('p');

  await ctx.waitFor('⋆');
}, 15_000);

test('it clusters overlay rows under repository headers when grouping is toggled on', async () => {
  await using ctx = setupTest();

  mkdirSync(join(ctx.home, 'otherproj'), { recursive: true });

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'first');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  pty.write(join(ctx.home, 'otherproj'));
  pty.write('\r');

  await ctx.waitFor('spawn: name');

  // The first spawn's prompt step is still in the buffer.
  ctx.reset();
  pty.write('second\r');

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('FAKE_CLAUDE_UP');

  ctx.reset();
  pty.write(CTRL_SPACE);

  await ctx.waitFor('second');

  expect(ctx.read()).not.toInclude('▸');

  ctx.reset();
  pty.write('g');

  await ctx.waitFor('▸');
  await ctx.waitFor('otherproj');
}, 15_000);

test('it lists a sub-session indented under its parent', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'wrangler');

  const daemon = await DaemonClient.open(join(ctx.home, 'atc-daemon.sock'));

  onTestFinished(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  const sessions = listed['sessions'];

  if (!Array.isArray(sessions) || !isRecord(sessions[0]) || typeof sessions[0]['id'] !== 'string') {
    throw new TypeError('session.list answered without the spawned session');
  }

  await daemon.sendRequest('session.spawn', {
    cwd: ctx.home,
    name: 'worker',
    parent: sessions[0]['id'],
    cols: 80,
    rows: 24,
  });

  ctx.reset();
  pty.write(CTRL_SPACE);

  await ctx.waitFor('↳ worker');

  const screen = ctx.read();

  expect(screen.indexOf('wrangler')).toBeLessThan(screen.indexOf('↳ worker'));
}, 15_000);

test('it preselects the focused session when the overlay opens', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'first');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

  // The first spawn's prompt step is still in the buffer.
  ctx.reset();
  pty.write('second\r');

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('FAKE_CLAUDE_UP');

  ctx.reset();
  pty.write(CTRL_SPACE);

  await ctx.waitFor('second');

  expect(ctx.read()).toInclude('\u001B[7msecond');
}, 15_000);

test('it opens the key reference from the overlay and returns on esc', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'helptest');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');

  pty.write('?');

  await ctx.waitFor('adopt an external session');

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor('helptest');
});

test('it adopts a session with --resume and yanks its resume command', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('adopt an existing session');

  pty.write('r');

  await ctx.waitFor('adopt: agent');

  pty.write('\r');

  await ctx.waitFor('adopt: directory');

  pty.write('\r');

  await ctx.waitFor('adopt: name');

  pty.write('adopted\r');

  await ctx.waitFor('FAKE_CLAUDE_UP');

  expect(ctx.read()).toInclude('--resume');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('need you: adopted');
  await ctx.waitFor('y yank');

  ctx.reset();
  pty.write('y');

  await ctx.waitFor('resume cmd copied');

  const b64 = ctx.read().split(']52;c;')[1]?.split(BEL)[0];

  if (b64 === undefined) {
    throw new Error('no OSC52 sequence in output');
  }

  const cmd = Buffer.from(b64, 'base64').toString();

  expect(cmd).toInclude('claude --resume fake-1');
  expect(cmd).toStartWith("cd '");
}, 15_000);

test('it chains the user statusline and appends the fleet segment', async () => {
  await using ctx = setupTest();

  mkdirSync(join(ctx.home, '.claude'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'echo CHAINED-SEGMENT' } }),
  );

  mkdirSync(join(ctx.home, '.local', 'state', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.home, '.local', 'state', 'atc', 'status.json'),
    JSON.stringify({ needs_you: 2, running: 1, done: 0, exited: 0, urgent: 'auth-bug' }),
  );

  const proc = Bun.spawn([process.execPath, join(repo, 'src', 'cli.ts'), 'statusline'], {
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: 'sl-1' })),
    env: collectEnv({ HOME: ctx.home, PATH: '/usr/sbin:/usr/bin:/bin' }),
    stdout: 'pipe',
  });

  const line = await new Response(proc.stdout).text();

  expect(line).toInclude('CHAINED-SEGMENT');
  expect(line).toInclude('2 need you: auth-bug');
  expect(line).toInclude('◐ 1');
});

test('it renames a session from the claude transcript custom-title', async () => {
  await using ctx = setupTest();

  writeFileSync(
    join(ctx.home, 'fake-transcript.jsonl'),
    `${JSON.stringify({
      type: 'custom-title',
      customTitle: 'claude-named',
      sessionId: 'fake-1',
    })}\n`,
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'typedname');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('claude-named');
});

test('it restores the fleet from disk after a crash', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'fleettest');

  const dbPath = join(ctx.home, '.local', 'state', 'atc', 'atc.db');
  const start = Date.now();
  let fleet: unknown[] = [];

  while (Date.now() - start < 3000) {
    try {
      const db = new Database(dbPath, { readonly: true });

      fleet = db.query('SELECT name, cwd, agent_session_id AS agentSessionID FROM fleet').all();

      db.close();
    } catch {}

    // The row lands at spawn, before the agent reports its session id, so
    // the wait runs until the row holds that id.
    if (fleet.some((row) => isRecord(row) && row['agentSessionID'] !== null)) {
      break;
    }

    await Bun.sleep(50);
  }

  // Simulate a full crash: client and daemon both die; the fleet row must
  // survive on disk.
  pty.kill();

  try {
    const pid = Number(readFileSync(join(ctx.home, 'atc-daemon.pid'), 'utf8'));

    process.kill(pid, 'SIGKILL');
  } catch {}

  await Bun.sleep(300); // let the killed processes release their sockets before rebooting

  expect(fleet).toStrictEqual([{ name: 'fleettest', cwd: ctx.home, agentSessionID: 'fake-1' }]);

  ctx.reset();

  const rebooted = ctx.boot();

  await ctx.waitFor('restore last fleet (1 sessions)');

  ctx.reset();
  rebooted.write('R');

  await ctx.waitFor('FAKE_CLAUDE_UP');
  await ctx.waitFor('--resume fake-1');
});

test('it restarts a daemon on another protocol after the user confirms and restores the fleet', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'fleettest');

  const stateDir = join(ctx.home, '.local', 'state', 'atc');
  const start = Date.now();
  let fleet: unknown[] = [];

  while (Date.now() - start < 3000) {
    try {
      const db = new Database(join(stateDir, 'atc.db'), { readonly: true });

      fleet = db.query('SELECT agent_session_id AS agentSessionID FROM fleet').all();

      db.close();
    } catch {}

    // The row lands at spawn, before the agent reports its session id, so
    // the wait runs until the row holds that id.
    if (fleet.some((row) => isRecord(row) && row['agentSessionID'] !== null)) {
      break;
    }

    await Bun.sleep(50);
  }

  pty.kill();

  const daemonPID = Number(readFileSync(join(ctx.home, 'atc-daemon.pid'), 'utf8'));

  process.kill(daemonPID, 'SIGKILL');

  await Bun.sleep(300); // let the killed processes release their sockets before the next daemon binds

  // A daemon on protocol v3 takes the socket and records its pid, as a
  // daemon from another release would.
  const sockPath = join(ctx.home, 'atc-daemon.sock');
  const daemonPath = join(ctx.home, 'legacy-daemon.ts');

  rmSync(sockPath, { force: true });

  writeFileSync(
    daemonPath,
    `import { writeFileSync } from 'node:fs';
import { startLegacyDaemon } from '${join(import.meta.dir, 'start-legacy-daemon.ts')}';
startLegacyDaemon('${sockPath}', { protocol: 3 });
writeFileSync('${join(stateDir, 'daemon.json')}', JSON.stringify({ pid: process.pid, socketPath: '${sockPath}', reporterSocketPath: '${join(ctx.home, 'atc.sock')}', eventsSocketPath: null }));
process.stdout.write('up\\n');
`,
  );

  const legacy = Bun.spawn([process.execPath, daemonPath], {
    env: collectEnv({ HOME: ctx.home, XDG_RUNTIME_DIR: ctx.home }),
    stdout: 'pipe',
    stderr: 'inherit',
  });

  onTestFinished(() => {
    legacy.kill('SIGKILL');
  });

  const reader = legacy.stdout.getReader();

  await reader.read();

  reader.releaseLock();

  expect(fleet).toStrictEqual([{ agentSessionID: 'fake-1' }]);

  ctx.reset();

  const rebooted = ctx.boot();

  await ctx.waitFor('Restart it now?');

  expect(ctx.read()).toInclude('daemon atc/legacy-build speaks v3');

  ctx.reset();
  rebooted.write('y');

  await ctx.waitFor('fleettest');

  await legacy.exited;

  expect(legacy.signalCode).toBe('SIGTERM');
});

test('it revives a killed session in place with a fresh terminal', async () => {
  await using ctx = setupTest();

  writeFileSync(join(ctx.home, 'fake-transcript.jsonl'), '{"type":"user"}\n');

  // The revived process paints a second late, after the attach has replayed
  // the killed process's screen.
  writeFileSync(join(ctx.home, 'fake-claude-delay-resume'), '');

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'revivable');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');

  pty.write('K');

  await ctx.waitFor('kill selected session?');

  ctx.reset();
  pty.write('y');

  await ctx.waitFor('killed');

  ctx.reset();
  pty.write('P');

  // The replayed screen of the killed process already holds FAKE_CLAUDE_UP,
  // so only the resume argument shows the revived process started.
  await ctx.waitFor('--resume fake-1');
}, 15_000);

test('it explains a revive that has no saved transcript instead of failing silently', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'transcriptless');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');

  pty.write('K');

  await ctx.waitFor('kill selected session?');

  ctx.reset();
  pty.write('y');

  await ctx.waitFor('killed');

  ctx.reset();
  pty.write('P');

  await ctx.waitFor('nothing to resume yet');
}, 15_000);

test('it spawns a grok session without resume or -p and marks it resumable', async () => {
  await using ctx = setupTest();

  // The agent reports its session a second after it starts, while its fleet
  // row already exists without the id.
  writeFileSync(join(ctx.home, 'fake-grok-delay-start'), '');

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, pty, 'groksess');

  const captured = ctx.read();

  // The TUI paints with cursor moves and no newlines, so the args reach the
  // capture on the same line as a whole screen of session names.
  const args = /FAKE_GROK_UP args:[^\r\n]*/.exec(captured);

  if (args === null) {
    throw new Error('no FAKE_GROK_UP args line was captured');
  }

  const [argsLine] = args;

  expect(argsLine).toInclude('FAKE_GROK_UP args: --no-leader');
  expect(argsLine).not.toInclude('--resume');
  expect(argsLine).not.toInclude('-p');
  expect(captured).not.toInclude('FAKE_CLAUDE_UP');

  const dbPath = join(ctx.home, '.local', 'state', 'atc', 'atc.db');
  const start = Date.now();
  let fleet: unknown[] = [];

  while (Date.now() - start < 3000) {
    try {
      const db = new Database(dbPath, { readonly: true });

      fleet = db
        .query('SELECT name, cwd, agent_session_id AS agentSessionID, agent FROM fleet')
        .all();

      db.close();
    } catch {}

    // The row lands at spawn, before the agent reports its session id, so
    // the wait runs until the row holds that id.
    if (fleet.some((row) => isRecord(row) && row['agentSessionID'] !== null)) {
      break;
    }

    await Bun.sleep(50);
  }

  expect(fleet).toStrictEqual([
    { name: 'groksess', cwd: ctx.home, agentSessionID: 'fake-grok-1', agent: 'grok' },
  ]);

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');
  await ctx.waitFor('\u001B[90mg\u001B[0m');
}, 15_000);

test('it marks a grok session done on end-turn Stop', async () => {
  await using ctx = setupTest();

  writeFileSync(
    join(ctx.home, 'fake-grok-events.jsonl'),
    `${JSON.stringify({
      hookEventName: 'stop',
      sessionId: 'fake-grok-1',
      reason: 'end_turn',
    })}\n`,
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, pty, 'grokdone');

  await ctx.waitFor('FAKE_GROK_HOOKS_DONE');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('done');
}, 15_000);

test('it marks a grok session done on StopCancelled', async () => {
  await using ctx = setupTest();

  writeFileSync(
    join(ctx.home, 'fake-grok-events.jsonl'),
    `${JSON.stringify({
      hookEventName: 'stop_cancelled',
      sessionId: 'fake-grok-1',
      reason: 'user_interrupt',
    })}\n`,
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, pty, 'grokcancel');

  await ctx.waitFor('FAKE_GROK_HOOKS_DONE');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('done');
}, 15_000);

test('it keeps a grok session running when a hook names a subagent', async () => {
  await using ctx = setupTest();

  writeFileSync(
    join(ctx.home, 'fake-grok-events.jsonl'),
    `${JSON.stringify({
      hookEventName: 'stop',
      sessionId: 'fake-grok-1',
      reason: 'end_turn',
      subagentType: 'explore',
    })}\n`,
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, pty, 'groksub');

  await ctx.waitFor('FAKE_GROK_HOOKS_DONE');

  ctx.reset();
  pty.write(CTRL_SPACE);

  await ctx.waitFor('running');

  expect(ctx.read()).not.toInclude('NEEDS YOU');
  expect(ctx.read()).not.toInclude('done');
}, 15_000);

test('it restores a grok session with grok --resume after a crash', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, pty, 'grokfleet');

  const dbPath = join(ctx.home, '.local', 'state', 'atc', 'atc.db');
  const start = Date.now();
  let fleet: unknown[] = [];

  while (Date.now() - start < 3000) {
    try {
      const db = new Database(dbPath, { readonly: true });

      fleet = db
        .query('SELECT name, cwd, agent_session_id AS agentSessionID, agent FROM fleet')
        .all();

      db.close();
    } catch {}

    // The row lands at spawn, before the agent reports its session id, so
    // the wait runs until the row holds that id.
    if (fleet.some((row) => isRecord(row) && row['agentSessionID'] !== null)) {
      break;
    }

    await Bun.sleep(50);
  }

  pty.kill();

  try {
    const pid = Number(readFileSync(join(ctx.home, 'atc-daemon.pid'), 'utf8'));

    process.kill(pid, 'SIGKILL');
  } catch {}

  await Bun.sleep(300); // let the killed processes release their sockets before rebooting

  expect(fleet).toStrictEqual([
    { name: 'grokfleet', cwd: ctx.home, agentSessionID: 'fake-grok-1', agent: 'grok' },
  ]);

  ctx.reset();

  const rebooted = ctx.boot();

  await ctx.waitFor('restore last fleet (1 sessions)');

  ctx.reset();
  rebooted.write('R');

  await ctx.waitFor('FAKE_GROK_UP');
  await ctx.waitFor('--resume fake-grok-1');

  expect(ctx.read()).not.toInclude('claude --resume');
  expect(ctx.read()).not.toInclude('FAKE_CLAUDE_UP');
}, 15_000);

test('it yanks a grok resume command once the id is captured', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, pty, 'grokyank');

  await ctx.waitFor('FAKE_GROK_HOOKS_DONE');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('need you: grokyank');

  ctx.reset();
  pty.write('y');

  await ctx.waitFor('resume cmd copied');

  const b64 = ctx.read().split(']52;c;')[1]?.split(BEL)[0];

  if (b64 === undefined) {
    throw new Error('no OSC52 sequence in output');
  }

  const cmd = Buffer.from(b64, 'base64').toString();

  expect(cmd).toBe(`cd '${ctx.home}' && grok --resume fake-grok-1`);
}, 15_000);

test('it yanks a grok command without --resume before SessionStart', async () => {
  await using ctx = setupTest();

  writeFileSync(join(ctx.home, 'fake-grok-hold-start'), '');

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, pty, 'grokearly');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('grokearly');

  ctx.reset();
  pty.write('y');

  await ctx.waitFor('resume cmd copied');

  const b64 = ctx.read().split(']52;c;')[1]?.split(BEL)[0];

  if (b64 === undefined) {
    throw new Error('no OSC52 sequence in output');
  }

  const cmd = Buffer.from(b64, 'base64').toString();

  expect(cmd).toBe(`cd '${ctx.home}' && grok`);
}, 15_000);

test('it ignores H on a grok row instead of opening the eject picker', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, pty, 'grokheadless');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('grokheadless');

  ctx.reset();
  pty.write('H');

  await Bun.sleep(200); // H on a Grok row is a no-op; no screen change to wait for

  expect(ctx.read()).not.toInclude('eject: headless instruction');

  pty.write('?');

  await ctx.waitFor('adopt an external session');

  expect(ctx.read()).not.toInclude('eject: headless instruction');
}, 15_000);

test('it adopts grok with --no-leader and without --resume', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('adopt an existing session');

  pty.write('r');

  await ctx.waitFor('adopt: agent');

  ctx.reset();
  pty.write('\u001B[B');

  await ctx.waitFor('\u001B[7mGrok');

  pty.write('\r');

  await ctx.waitFor('adopt: directory');

  pty.write('\r');

  await ctx.waitFor('adopt: name');

  pty.write('adoptedg\r');

  await ctx.waitFor('FAKE_GROK_UP');

  const captured = ctx.read();

  // The TUI paints with cursor moves and no newlines, so the args reach the
  // capture on the same line as a whole screen of session names.
  const args = /FAKE_GROK_UP args:[^\r\n]*/.exec(captured);

  if (args === null) {
    throw new Error('no FAKE_GROK_UP args line was captured');
  }

  const [argsLine] = args;

  expect(argsLine).toInclude('FAKE_GROK_UP args: --no-leader');
  expect(argsLine).not.toInclude('--resume');
  expect(argsLine).not.toInclude('-p');
  expect(captured).not.toInclude('FAKE_CLAUDE_UP');
}, 15_000);

test('it keeps NEEDS YOU when grok emits idle_prompt after permission_prompt', async () => {
  await using ctx = setupTest();

  writeFileSync(
    join(ctx.home, 'fake-grok-events.jsonl'),
    `${JSON.stringify({
      hookEventName: 'notification',
      sessionId: 'fake-grok-1',
      notificationType: 'permission_prompt',
      message: 'allow edit?',
    })}\n${JSON.stringify({
      hookEventName: 'notification',
      sessionId: 'fake-grok-1',
      notificationType: 'idle_prompt',
    })}\n`,
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnGrokSession(ctx, pty, 'grokidle');

  await ctx.waitFor('FAKE_GROK_HOOKS_DONE');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');
}, 15_000);

test('it leaves an agent with no installed binary out of the picker', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  ctx.reset();
  pty.write('n');

  await ctx.waitFor('spawn: agent');

  const menu = ctx.read();

  expect(menu).toInclude('Claude');
  expect(menu).toInclude('Grok');
  expect(menu).not.toInclude('Codex');

  pty.write('\u001B[B');

  await ctx.waitFor('\u001B[7mGrok');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');
}, 15_000);

test('it shows a refused spawn in the picker and keeps the entered prompt', async () => {
  await using ctx = setupTest();

  // A config that is not JSON drops the configured claude binary, so the
  // default name resolves on PATH to the fake one and the daemon's target
  // check is what refuses the spawn.
  writeFileSync(join(ctx.home, '.config', 'atc', 'config.json'), '{ "targets": ');
  mkdirSync(join(ctx.home, 'bin'));
  symlinkSync(join(ctx.home, 'fake-claude'), join(ctx.home, 'bin', 'claude'));

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

  ctx.reset();
  pty.write('broken\r');

  await ctx.waitFor('spawn: initial prompt');

  pty.write('hello');

  await ctx.waitFor('> hello');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('target_config_invalid: config file');

  const screen = ctx.read();

  expect(screen).toInclude('spawn: initial prompt');
  expect(screen).toInclude('> hello');
  expect(screen).not.toInclude('FAKE_CLAUDE_UP');
}, 15_000);

test('it spawns on the target chosen in the target step, keeping the choice across esc', async () => {
  await using ctx = setupTest();

  const configPath = join(ctx.home, '.config', 'atc', 'config.json');
  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

  writeFileSync(
    configPath,
    JSON.stringify({
      ...(isRecord(config) ? config : {}),
      targets: {
        local: { provider: 'local-pty' },
        alt: { provider: 'local-pty', tag: 'alt' },
        far: { provider: 'nowhere' },
      },
      defaultTarget: 'local',
    }),
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: target');

  const menu = ctx.read();

  expect(menu).toInclude('\u001B[7mlocal  local-pty · default');
  expect(menu).toInclude('\u001B[90mfar  nowhere · unavailable');

  ctx.reset();
  pty.write('\u001B[B');

  await ctx.waitFor('\u001B[7malt  local-pty');

  pty.write('x');
  pty.write('\r');

  await ctx.waitFor('spawn: name');

  expect(ctx.read()).not.toInclude('> x');

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor('\u001B[7malt  local-pty');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: name');

  pty.write('elsewhere\r');

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('FAKE_CLAUDE_UP');

  const daemon = await DaemonClient.open(join(ctx.home, 'atc-daemon.sock'));

  onTestFinished(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([
    { name: 'elsewhere', cwd: ctx.home, locator: { targetID: 'alt' } },
  ]);
}, 20_000);

test('it keeps the target step open on a target the directory cannot run on', async () => {
  await using ctx = setupTest();

  const configPath = join(ctx.home, '.config', 'atc', 'config.json');
  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

  writeFileSync(
    configPath,
    JSON.stringify({
      ...(isRecord(config) ? config : {}),
      targets: { local: { provider: 'local-pty' }, far: { provider: 'nowhere' } },
      defaultTarget: 'local',
    }),
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  pty.write('\r');

  await ctx.waitFor('spawn: target');

  ctx.reset();
  pty.write('\u001B[B');

  await ctx.waitFor('\u001B[7mfar  nowhere');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor("target 'far' is unavailable on this daemon");

  expect(ctx.read()).not.toInclude('spawn: name');

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor('spawn: directory');
}, 15_000);

test('it spawns a session from a git repository at the commit the confirm screen shows, keeping choices across esc', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  const dest = join(
    ctx.home,
    '.local',
    'share',
    'atc',
    'workspaces',
    `upstream-main-${fixture.sha.slice(0, 7)}`,
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx, pty);

  await ctx.waitFor('gh is not signed in on the daemon host');

  ctx.reset();
  pty.write(`${fixture.upstream}\r`);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor(`> ${dest}`);

  expect(ctx.read()).toInclude(`main → ${fixture.sha.slice(0, 12)}`);
  expect(ctx.read()).toInclude('dest    local:/');

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor(`> ${fixture.upstream}`);

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: confirm');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: name');

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor(`> ${dest}`);

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: name');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('FAKE_CLAUDE_UP', 10_000);

  const daemon = await DaemonClient.open(join(ctx.home, 'atc-daemon.sock'));

  onTestFinished(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  expect(listed['sessions']).toMatchObject([
    { cwd: dest, workspace: { repoURL: fixture.upstream, sha: fixture.sha, ref: 'main' } },
  ]);

  expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe('hello\n');
}, 30_000);

test('it filters refs by name and refuses an abbreviated commit id on the ref step', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx, pty);

  pty.write(`${fixture.upstream}\r`);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  pty.write('b');

  await ctx.waitFor('> b');

  expect(ctx.read()).not.toInclude('main  default');

  pty.write('\u0015');
  ctx.reset();
  pty.write(`${fixture.sha.slice(0, 7)}\r`);

  await ctx.waitFor('full commit id required');

  expect(ctx.read()).not.toInclude('spawn: confirm');
}, 20_000);

test("it lists the gh account's repositories and an owner's on request, and leaves on esc", async () => {
  await using ctx = setupTest();

  writeFakeGH(
    ctx.home,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${join(ctx.home, 'gh-argv')}'
case "$1 $3" in
  "config "*) echo https ;;
  "repo --limit") echo '[{"nameWithOwner":"me/dots","description":"dotfiles","isPrivate":false,"url":"https://github.com/me/dots","sshUrl":"git@github.com:me/dots.git"}]' ;;
  *) echo '[{"nameWithOwner":"acme/app","description":"","isPrivate":true,"url":"https://github.com/acme/app","sshUrl":"git@github.com:acme/app.git"}]' ;;
esac
`,
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx, pty);

  await ctx.waitFor('me/dots  dotfiles');

  ctx.reset();
  pty.write('acme/\r');

  await ctx.waitFor('acme/app  private');

  expect(ctx.read()).toInclude('spawn: GitHub repository · acme');

  expect(readFileSync(join(ctx.home, 'gh-argv'), 'utf8')).toMatch(
    /^repo list --limit .*\nconfig get git_protocol\nrepo list acme --limit .*\nconfig get git_protocol\n$/u,
  );

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor('spawn: agent');
}, 20_000);

test('it returns a spawn into an existing destination to the confirm screen with a suffix offered', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  const dest = join(
    ctx.home,
    '.local',
    'share',
    'atc',
    'workspaces',
    `upstream-main-${fixture.sha.slice(0, 7)}`,
  );

  mkdirSync(dest, { recursive: true });

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx, pty);

  pty.write(`${fixture.upstream}\r`);

  await ctx.waitFor('spawn: ref');

  pty.write('\r');

  await ctx.waitFor('spawn: confirm');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

  pty.write('\r');

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('workspace_exists', 10_000);

  expect(ctx.read()).toInclude(`> ${dest}-2`);

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: name');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('FAKE_CLAUDE_UP', 10_000);

  expect(readFileSync(join(`${dest}-2`, 'README.md'), 'utf8')).toBe('hello\n');
}, 30_000);

test('it returns a spawn whose clone fails to the repository step', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx, pty);

  pty.write(`${fixture.upstream}\r`);

  await ctx.waitFor('spawn: ref');

  pty.write('\r');

  await ctx.waitFor('spawn: confirm');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

  pty.write('\r');

  await ctx.waitFor('spawn: initial prompt');

  rmSync(fixture.upstream, { recursive: true, force: true });

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('clone_failed', 10_000);

  expect(ctx.read()).toInclude('spawn: GitHub repository');
}, 30_000);

test('it returns a spawn whose commit left the upstream to the ref step with the refs re-read', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx, pty);

  pty.write(`${fixture.upstream}\r`);

  await ctx.waitFor('spawn: ref');

  pty.write('\r');

  await ctx.waitFor('spawn: confirm');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

  pty.write('\r');

  await ctx.waitFor('spawn: initial prompt');

  // Main moves to an unrelated commit and the old one is pruned, so the
  // pinned commit is no longer in the upstream.
  await $`git checkout --quiet --orphan rewritten`.env(fixture.env).cwd(fixture.work).quiet();
  await $`git commit --quiet --no-gpg-sign -m rewritten`.env(fixture.env).cwd(fixture.work).quiet();

  await $`git push --quiet --force origin rewritten:main`
    .env(fixture.env)
    .cwd(fixture.work)
    .quiet();

  await $`git reflog expire --expire=now --all`.env(fixture.env).cwd(fixture.upstream).quiet();
  await $`git gc --quiet --prune=now`.env(fixture.env).cwd(fixture.upstream).quiet();

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('refs re-read', 10_000);

  const rewritten = await $`git rev-parse HEAD`
    .env(fixture.env)
    .cwd(fixture.work)
    .text()
    .then((text) => text.trim());

  expect(ctx.read()).toInclude('ref_not_found');
  expect(ctx.read()).toInclude('spawn: ref');
  expect(ctx.read()).toInclude(`main  default · ${rewritten.slice(0, 7)}`);

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor(`main → ${rewritten.slice(0, 12)}`);

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: name');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('FAKE_CLAUDE_UP', 10_000);
}, 40_000);

test('it shows a repository the daemon cannot read on the repository step', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx, pty);

  ctx.reset();
  pty.write(`${join(ctx.home, 'missing.git')}\r`);

  await ctx.waitFor('clone_failed');

  expect(ctx.read()).toInclude('spawn: GitHub repository');
  expect(ctx.read()).not.toInclude('spawn: ref');
}, 20_000);

test('it keeps paths and slash filters in the local directory step and switches source on tab or a pasted URL', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  pty.write('~/');

  await ctx.waitFor('> ~/');

  pty.write('\u0015');
  pty.write('atc/src');

  await ctx.waitFor('> atc/src');

  expect(ctx.read()).not.toInclude('spawn: GitHub repository');

  ctx.reset();
  pty.write('\t');

  await ctx.waitFor('spawn: GitHub repository');

  ctx.reset();
  pty.write('\t');

  await ctx.waitFor('spawn: git URL');

  ctx.reset();
  pty.write('\t');

  await ctx.waitFor('spawn: directory on the daemon host');

  ctx.reset();
  pty.write('https://github.com/acme/app.git');

  await ctx.waitFor('spawn: GitHub repository');

  expect(ctx.read()).toInclude('> https://github.com/acme/app.git');
}, 20_000);

test('it sends a local directory to a target off the daemon machine as a path workspace without allowDirty', async () => {
  await using ctx = setupTest();

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'atc',
    GIT_AUTHOR_EMAIL: 'atc@example.com',
    GIT_COMMITTER_NAME: 'atc',
    GIT_COMMITTER_EMAIL: 'atc@example.com',
  };

  const project = join(ctx.home, 'proj');

  await $`git init --quiet --template= --initial-branch=main ${project}`.env(env).quiet();

  writeFileSync(join(project, 'README.md'), 'hello\n');

  await $`git add README.md`.env(env).cwd(project).quiet();
  await $`git commit --quiet --no-gpg-sign -m initial`.env(env).cwd(project).quiet();

  writeFileSync(join(project, 'scratch.txt'), 'uncommitted\n');

  const configPath = join(ctx.home, '.config', 'atc', 'config.json');
  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

  // An imp target with a url and no token has a provider that can take a
  // workspace. The path source is refused before the daemon calls impd.
  writeFileSync(
    configPath,
    JSON.stringify({
      ...(isRecord(config) ? config : {}),
      targets: {
        local: { provider: 'local-pty' },
        box: { provider: 'imp', url: 'http://127.0.0.1:9' },
      },
      defaultTarget: 'local',
    }),
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  pty.write(project);

  await ctx.waitFor(`> ${project}`);

  pty.write('\r');

  await ctx.waitFor('spawn: target');

  ctx.reset();
  pty.write('\u001B[B');

  await ctx.waitFor('\u001B[7mbox  imp');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

  pty.write('\r');

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  pty.write('\r');

  // Without the path workspace the spawn would reach impd; with
  // allowDirty: 'warn' it would get past the uncommitted file.
  await ctx.waitFor('workspace_dirty', 10_000);

  expect(ctx.read()).not.toInclude('FAKE_CLAUDE_UP');
}, 20_000);

test('it opens github mode on a target that takes a workspace when the default cannot, and esc at the target step returns to the directory', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  const configPath = join(ctx.home, '.config', 'atc', 'config.json');
  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

  writeFileSync(
    configPath,
    JSON.stringify({
      ...(isRecord(config) ? config : {}),
      targets: { local: { provider: 'local-pty' }, far: { provider: 'nowhere' } },
      defaultTarget: 'far',
    }),
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  pty.write('\t');

  await ctx.waitFor('spawn: target');

  expect(ctx.read()).toInclude('\u001B[7mlocal  local-pty');
  expect(ctx.read()).toInclude('\u001B[90mfar  nowhere · default · unavailable');

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  pty.write('\t');

  await ctx.waitFor('spawn: target');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: GitHub repository');

  ctx.reset();
  pty.write(`${fixture.upstream}\r`);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('target  local (local-pty)');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: name');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('FAKE_CLAUDE_UP', 10_000);
}, 30_000);

test("it builds each target's own default destination when the target changes", async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  const name = `upstream-main-${fixture.sha.slice(0, 7)}`;
  const configPath = join(ctx.home, '.config', 'atc', 'config.json');
  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

  writeFileSync(
    configPath,
    JSON.stringify({
      ...(isRecord(config) ? config : {}),
      targets: { local: { provider: 'local-pty' }, alt: { provider: 'local-pty', tag: 'alt' } },
      defaultTarget: 'local',
      workspaces: {
        gitTransports: FIXTURE_GIT_TRANSPORTS,
        targets: { alt: join(ctx.home, 'alt-ws') },
      },
    }),
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  pty.write('\t');

  await ctx.waitFor('spawn: target');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: GitHub repository');

  ctx.reset();
  pty.write(`${fixture.upstream}\r`);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor(`> ${join(ctx.home, '.local', 'share', 'atc', 'workspaces', name)}`);

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor(`> ${fixture.upstream}`);

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor('spawn: target');

  ctx.reset();
  pty.write('\u001B[B');

  await ctx.waitFor('\u001B[7malt  local-pty');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor(`> ${fixture.upstream}`);

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor(`> ${join(ctx.home, 'alt-ws', name)}`);

  expect(ctx.read()).toInclude('target  alt (local-pty)');
}, 30_000);

test('it refuses a remote target workspace root and destination that rely on ~', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  const configPath = join(ctx.home, '.config', 'atc', 'config.json');
  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

  // An imp target with a url and no token takes a workspace; nothing here
  // reaches impd, since no spawn is sent.
  writeFileSync(
    configPath,
    JSON.stringify({
      ...(isRecord(config) ? config : {}),
      targets: {
        local: { provider: 'local-pty' },
        box: { provider: 'imp', url: 'http://127.0.0.1:9' },
      },
      defaultTarget: 'local',
      workspaces: { gitTransports: FIXTURE_GIT_TRANSPORTS, targets: { box: '~/ws' } },
    }),
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  pty.write('\t');

  await ctx.waitFor('spawn: target');

  ctx.reset();
  pty.write('\u001B[B');

  await ctx.waitFor('\u001B[7mbox  imp');

  pty.write('\r');

  await ctx.waitFor('spawn: GitHub repository');

  ctx.reset();
  pty.write(`${fixture.upstream}\r`);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('set workspaces.targets.box in config.json to an absolute path on that target');

  expect(ctx.read()).toInclude('dest    box:');

  ctx.reset();
  pty.write('~/ws/app\r');

  await ctx.waitFor('~ is not expanded there');

  expect(ctx.read()).not.toInclude('spawn: name');
}, 30_000);

test('it offers the other URL form after a failed probe and checks that form on request', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  const mirror = join(ctx.home, 'mirror', 'acme', 'app.git');

  mkdirSync(join(ctx.home, 'mirror', 'acme'), { recursive: true });

  await $`git clone --quiet --bare --template= ${fixture.upstream} ${mirror}`
    .env(fixture.env)
    .quiet();

  // The daemon reads the home's git config: the ssh form of acme/app reads
  // the mirror, and the https form reads a path that does not exist, so no
  // request reaches GitHub.
  writeFileSync(
    join(ctx.home, '.gitconfig'),
    `[url "file://${join(ctx.home, 'mirror')}/"]\n\tinsteadOf = git@github.com:\n[url "file://${join(ctx.home, 'nowhere')}/"]\n\tinsteadOf = https://github.com/\n`,
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx, pty);

  ctx.reset();
  pty.write('acme/app\r');

  await ctx.waitFor('try git@github.com:acme/app.git instead');

  expect(ctx.read()).toInclude('clone_failed');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('source  git@github.com:acme/app.git');
}, 30_000);

test('it stops a repository listing on esc and keeps taking typed input', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home, SLOW_GH);

  const fixture = await createFixtureUpstream(ctx.home);

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx, pty);

  await ctx.waitFor('listing…');

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor('listing stopped');

  // The fake gh answers 1.5 seconds after it starts; nothing signals that
  // its dropped answer reached the client, so the test outwaits it.
  await Bun.sleep(2500);

  expect(ctx.read()).toInclude('spawn: GitHub repository');
  expect(ctx.read()).not.toInclude('me/dots');

  ctx.reset();
  pty.write(`${fixture.upstream}\r`);

  await ctx.waitFor('spawn: ref');
}, 20_000);

test('it cancels a probe in flight on esc and drops its answer', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch() {
      await Bun.sleep(1500);

      return new Response('not found', { status: 404 });
    },
  });

  onTestFinished(async () => {
    await server.stop(true);
  });

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx, pty);

  ctx.reset();
  pty.write(`http://127.0.0.1:${server.port}/silent.git\r`);

  await ctx.waitFor('checking access');

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor('cancelled');

  // The server answers 1.5 seconds after the request; nothing signals that
  // the dropped answer reached the client, so the test outwaits it.
  await Bun.sleep(2500);

  expect(ctx.read()).toInclude('spawn: GitHub repository');
  expect(ctx.read()).not.toInclude('clone_failed');

  pty.write('\u0015');
  ctx.reset();
  pty.write(`${fixture.upstream}\r`);

  await ctx.waitFor('spawn: ref');
}, 20_000);

test('it keeps the ref the user moved to when a repository listing answers late', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home, SLOW_GH.replace('sleep 1.5', 'sleep 2'));

  const fixture = await createFixtureUpstream(ctx.home);

  await $`git push --quiet origin main:feat`.env(fixture.env).cwd(fixture.work).quiet();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx, pty);

  ctx.reset();
  pty.write(`${fixture.upstream}\r`);

  await ctx.waitFor('spawn: ref');
  await ctx.waitFor('feat');

  ctx.reset();
  pty.write('\u001B[B');

  await ctx.waitFor('\u001B[7mfeat');

  // The fake gh answers 2 seconds after the step opened; nothing signals
  // that the late listing reached the client, so the test outwaits it.
  await Bun.sleep(2500);

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: confirm');

  expect(ctx.read()).toInclude(`feat → ${fixture.sha.slice(0, 12)}`);
}, 20_000);

test('it leaves the picker when esc stops waiting on a spawn, and the spawn lists one session', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  // Every authenticated request waits 1.5 seconds, so the clone behind the
  // spawn takes several. The home's git config supplies the basic auth the
  // server asks for.
  const server = startGitHTTPServer(ctx.home, fixture.env, { delayMs: 1500 });

  onTestFinished(async () => {
    await server.stop();
  });

  writeFileSync(
    join(ctx.home, '.gitconfig'),
    '[credential]\n\thelper = "!f() { echo username=atc; echo password=fixture; }; f"\n',
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx, pty);

  ctx.reset();
  pty.write(`${server.url}upstream.git\r`);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`, 8000);

  pty.write('\r');

  await ctx.waitFor('spawn: confirm');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

  pty.write('slowclone\r');

  await ctx.waitFor('spawn: initial prompt');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('esc stops waiting; the session still lists');

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor('atc — control tower');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('slowclone', 15_000);

  // The spawn answers once its session starts; nothing signals that the
  // dropped answer reached the client, so the test outwaits it.
  await Bun.sleep(1000);

  expect(ctx.read()).not.toInclude('FAKE_CLAUDE_UP');
  expect(ctx.read()).not.toInclude('spawn: initial prompt');

  const daemon = await DaemonClient.open(join(ctx.home, 'atc-daemon.sock'));

  onTestFinished(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  expect(listed['sessions']).toBeArrayOfSize(1);
}, 40_000);

test('it drops a typed destination when the repository changes', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  const other = join(ctx.home, 'other.git');

  await $`git clone --quiet --bare --template= ${fixture.upstream} ${other}`
    .env(fixture.env)
    .quiet();

  const custom = join(ctx.home, 'custom-dest');
  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await openRepoStep(ctx, pty);

  ctx.reset();
  pty.write(`${fixture.upstream}\r`);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: confirm');

  pty.write('\u0015');
  pty.write(`${custom}\r`);

  await ctx.waitFor('spawn: name');

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor(`> ${custom}`);

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor(`> ${fixture.upstream}`);

  pty.write('\u0015');
  ctx.reset();
  pty.write(`${other}\r`);

  await ctx.waitFor('spawn: ref');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: confirm');

  expect(ctx.read()).toInclude(`other-main-${fixture.sha.slice(0, 7)}`);
  expect(ctx.read()).not.toInclude(custom);
}, 30_000);

test('it drives a source the daemon composition adds from its candidates to the confirm screen', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  // A daemon started first holds the socket, so the client connects to it
  // instead of starting its own; it prints a line once it listens.
  const daemon = Bun.spawn([process.execPath, join(repo, 'test', 'run-source-daemon.ts')], {
    env: collectEnv({
      HOME: ctx.home,
      XDG_RUNTIME_DIR: ctx.home,
      PATH: `${join(ctx.home, 'bin')}:/usr/sbin:/usr/bin:/bin`,
      ATC_TEST_SOURCES: 'fixture',
      ATC_TEST_FIXTURE_URL: fixture.upstream,
    }),
    stdout: 'pipe',
    stderr: 'ignore',
  });

  onTestFinished(() => {
    daemon.kill();
  });

  const reader = daemon.stdout.getReader();

  await reader.read();

  reader.releaseLock();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('tab GitHub repository');

  pty.write('\t');

  await ctx.waitFor('tab git URL');

  pty.write('\t');

  await ctx.waitFor('tab fixture repository');

  ctx.reset();
  pty.write('\t');

  await ctx.waitFor('upstream  fixture');

  expect(ctx.read()).toInclude('spawn: fixture repository');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: confirm');

  expect(ctx.read()).toInclude(`source  ${fixture.upstream}`);
}, 30_000);

test('it offers the local directory flow alone when the daemon offers no sources', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const daemon = Bun.spawn([process.execPath, join(repo, 'test', 'run-source-daemon.ts')], {
    env: collectEnv({
      HOME: ctx.home,
      XDG_RUNTIME_DIR: ctx.home,
      PATH: `${join(ctx.home, 'bin')}:/usr/sbin:/usr/bin:/bin`,
      ATC_TEST_SOURCES: 'none',
    }),
    stdout: 'pipe',
    stderr: 'ignore',
  });

  onTestFinished(() => {
    daemon.kill();
  });

  const reader = daemon.stdout.getReader();

  await reader.read();

  reader.releaseLock();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  expect(ctx.read()).not.toInclude('tab ');
  expect(ctx.read()).not.toInclude('on the daemon host');

  ctx.reset();
  pty.write('\t');
  pty.write('\r');

  await ctx.waitFor('spawn: name');

  expect(ctx.read()).not.toInclude('spawn: GitHub repository');
}, 30_000);

test('it lists an owner typed in the directory step through the source that reads it', async () => {
  await using ctx = setupTest();

  writeFakeGH(
    ctx.home,
    `#!/bin/sh
case "$1" in
  config) echo https ;;
  *) echo '[{"nameWithOwner":"acme/app","description":"","isPrivate":true,"url":"https://github.com/acme/app","sshUrl":"git@github.com:acme/app.git"}]' ;;
esac
`,
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  pty.write('acme/\r');

  await ctx.waitFor('spawn: GitHub repository · acme');
  await ctx.waitFor('acme/app  private');
}, 20_000);

test('it probes a repository typed in the directory step at the URL its source reads it as', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  mkdirSync(join(ctx.home, 'mirror', 'acme'), { recursive: true });

  await $`git clone --quiet --bare --template= ${fixture.upstream} ${join(ctx.home, 'mirror', 'acme', 'app.git')}`
    .env(fixture.env)
    .quiet();

  // The daemon reads the home's git config, which sends the https form of
  // acme/app to the mirror, so no request reaches GitHub.
  writeFileSync(
    join(ctx.home, '.gitconfig'),
    `[url "file://${join(ctx.home, 'mirror')}/"]\n\tinsteadOf = https://github.com/\n`,
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory');

  ctx.reset();
  pty.write('acme/app\r');

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('source  https://github.com/acme/app.git');
}, 30_000);

test('it opens the sources in the order the config gives', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  const fixture = await createFixtureUpstream(ctx.home);

  const configPath = join(ctx.home, '.config', 'atc', 'config.json');
  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

  writeFileSync(
    configPath,
    JSON.stringify({
      ...(isRecord(config) ? config : {}),
      workspaces: { gitTransports: FIXTURE_GIT_TRANSPORTS, sources: ['git', 'dirs'] },
    }),
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('spawn: git URL');

  expect(ctx.read()).toInclude('tab directory on the daemon host');

  ctx.reset();
  pty.write(`${fixture.upstream}\r`);

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`);

  ctx.reset();
  pty.write('\u001B');

  await ctx.waitFor(`> ${fixture.upstream}`);

  ctx.reset();
  pty.write('\t');

  await ctx.waitFor('spawn: directory on the daemon host');

  expect(ctx.read()).not.toInclude('GitHub');
}, 30_000);

test('it stays where the user moved when a directory listing answers late', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  // The daemon runs zoxide from the PATH the client gives it, so every
  // directory listing takes 1.5 seconds.
  writeFileSync(join(ctx.home, 'bin', 'zoxide'), '#!/bin/sh\nsleep 1.5\n', { mode: 0o755 });

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory on the daemon host');

  pty.write('\t');

  await ctx.waitFor('spawn: GitHub repository');

  pty.write('\t');

  await ctx.waitFor('spawn: git URL');

  ctx.reset();
  pty.write('\t');

  // The tab draws nothing until the listing answers, so a short pause keeps
  // it and the esc in separate reads.
  await Bun.sleep(300);

  pty.write('\u001B');

  await ctx.waitFor('spawn: agent');

  // The listing answers 1.5 seconds after the tab; nothing signals that the
  // dropped answer reached the client, so the test outwaits it.
  ctx.reset();

  await Bun.sleep(2500);

  expect(ctx.read()).not.toInclude('directory on the daemon host');
}, 20_000);

test('it keeps a probe started on a git source after a tab in that flow, spawning one git workspace', async () => {
  await using ctx = setupTest();

  writeFakeGH(ctx.home);

  // Every directory listing takes a second, and every authenticated git
  // request 1.5 seconds, so the tab's listing answers before the probe.
  writeFileSync(join(ctx.home, 'bin', 'zoxide'), '#!/bin/sh\nsleep 1\n', { mode: 0o755 });

  const fixture = await createFixtureUpstream(ctx.home);

  const server = startGitHTTPServer(ctx.home, fixture.env, { delayMs: 1500 });

  onTestFinished(async () => {
    await server.stop();
  });

  writeFileSync(
    join(ctx.home, '.gitconfig'),
    '[credential]\n\thelper = "!f() { echo username=atc; echo password=fixture; }; f"\n',
  );

  const url = `${server.url}upstream.git`;
  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('n');

  await ctx.waitFor('spawn: agent');

  pty.write('\r');

  await ctx.waitFor('spawn: directory on the daemon host');

  pty.write('\t');

  await ctx.waitFor('spawn: GitHub repository');

  pty.write('\t');

  await ctx.waitFor('spawn: git URL');

  ctx.reset();
  pty.write(url);

  await ctx.waitFor(`> ${url}`);

  pty.write('\t');

  // The tab draws nothing until its listing answers, so a short pause keeps
  // it and the enter in separate reads.
  await Bun.sleep(200);

  pty.write('\r');

  await ctx.waitFor(`main  default · ${fixture.sha.slice(0, 7)}`, 10_000);

  pty.write('\r');

  await ctx.waitFor('spawn: confirm');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

  pty.write('raced\r');

  await ctx.waitFor('spawn: initial prompt');

  pty.write('\r');

  await ctx.waitFor('FAKE_CLAUDE_UP', 20_000);

  const daemon = await DaemonClient.open(join(ctx.home, 'atc-daemon.sock'));

  onTestFinished(() => {
    daemon.stop();
  });

  await daemon.sendHello('atc/test');

  const listed = await daemon.sendRequest('session.list');

  expect(listed['sessions']).toBeArrayOfSize(1);

  expect(listed['sessions']).toMatchObject([
    { name: 'raced', workspace: { repoURL: url, sha: fixture.sha, ref: 'main' } },
  ]);
}, 60_000);

test('it offers an adopt only the targets that run on this host', async () => {
  await using ctx = setupTest();

  const configPath = join(ctx.home, '.config', 'atc', 'config.json');
  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));

  writeFileSync(
    configPath,
    JSON.stringify({
      ...(isRecord(config) ? config : {}),
      targets: {
        local: { provider: 'local-pty' },
        alt: { provider: 'local-pty', tag: 'alt' },
        box: { provider: 'imp', url: 'http://127.0.0.1:9' },
      },
      defaultTarget: 'local',
    }),
  );

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  pty.write('r');

  await ctx.waitFor('adopt: agent');

  pty.write('\r');

  await ctx.waitFor('adopt: directory');

  ctx.reset();
  pty.write('\r');

  await ctx.waitFor('adopt: target');

  const menu = ctx.read();

  expect(menu).toInclude('local  local-pty · default');
  expect(menu).toInclude('alt  local-pty');
  expect(menu).not.toInclude('box  imp');
}, 15_000);
