import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'bun-pty';
import type { IPty } from 'bun-pty';

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

function setupTest(): TestContext {
  const home = mkdtempSync(join(tmpdir(), 'atc-test-'));

  mkdirSync(join(home, '.config', 'atc'), { recursive: true });

  const fakeClaude = join(home, 'fake-claude');

  // Like real Claude Code, the fake repaints its screen on SIGWINCH — the
  // attach jiggle depends on exactly that behavior for replay.
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
ARGS="$*"
paint() { echo "FAKE_CLAUDE_UP args: $ARGS"; }
trap paint WINCH
paint
printf '{"hook_event_name":"SessionStart","session_id":"fake-1","transcript_path":"'"$HOME"'/fake-transcript.jsonl"}' | "${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report
sleep 0.3
printf '{"hook_event_name":"Notification","session_id":"fake-1","message":"needs permission"}' | "${process.execPath}" "${join(repo, 'src', 'cli.ts')}" hook-report
for _ in $(seq 1 300); do
  if read -t 0.1 -r line; then echo "GOT:$line"; fi
done
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(home, '.config', 'atc', 'config.json'),
    JSON.stringify({ claudeBin: fakeClaude, claudeArgs: [] }),
  );

  let pty: IPty | null = null;
  let out = '';

  return {
    home,

    boot() {
      pty = spawn(process.execPath, [join(repo, 'src', 'cli.ts')], {
        name: 'xterm-256color',
        cols: 110,
        rows: 30,
        cwd: repo,
        env: collectEnv({ HOME: home, XDG_RUNTIME_DIR: home, PATH: '/usr/sbin:/usr/bin:/bin' }),
      });

      pty.onData((d) => {
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

      while (Date.now() - start < ms) {
        if (out.includes(needle)) {
          return;
        }

        await Bun.sleep(50);
      }

      throw new Error(
        `timed out waiting for ${JSON.stringify(needle)}; tail: ${JSON.stringify(out.slice(-400))}`,
      );
    },

    [Symbol.asyncDispose]() {
      pty?.kill();

      // The client auto-spawned a daemon inside this test's HOME; its pid
      // file is how the harness finds and stops it.
      try {
        const pid = Number(readFileSync(join(home, 'atc-daemon.pid'), 'utf8'));

        if (Number.isInteger(pid) && pid > 1) {
          process.kill(pid, 'SIGTERM');
        }
      } catch {}

      rmSync(home, { recursive: true, force: true });

      return Promise.resolve();
    },
  };
}

async function spawnSession(ctx: TestContext, pty: IPty, name: string) {
  pty.write('n');

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
});

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
    JSON.stringify({ claudeBin: join(ctx.home, 'fake-claude'), claudeArgs: [], leader: 'ctrl-]' }),
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

test('it preselects the focused session when the overlay opens', async () => {
  await using ctx = setupTest();

  const pty = ctx.boot();

  await ctx.waitFor('atc — control tower');

  await spawnSession(ctx, pty, 'first');

  pty.write(CTRL_SPACE);

  await ctx.waitFor('NEEDS YOU');

  pty.write('n');

  await ctx.waitFor('spawn: directory');

  pty.write('\r');

  await ctx.waitFor('spawn: name');

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

  await ctx.waitFor('adopt: directory');

  pty.write('\r');

  await ctx.waitFor('adopt: name');

  ctx.reset();
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
});

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

      fleet = db.query('SELECT name, cwd, claude_id AS claudeId FROM fleet').all();

      db.close();
    } catch {}

    if (fleet.length > 0) {
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

  expect(fleet).toStrictEqual([{ name: 'fleettest', cwd: ctx.home, claudeId: 'fake-1' }]);

  ctx.reset();

  const rebooted = ctx.boot();

  await ctx.waitFor('restore last fleet (1 sessions)');

  ctx.reset();
  rebooted.write('R');

  await ctx.waitFor('FAKE_CLAUDE_UP');
  await ctx.waitFor('--resume fake-1');
});

test('it revives a killed session in place with a fresh terminal', async () => {
  await using ctx = setupTest();

  writeFileSync(join(ctx.home, 'fake-transcript.jsonl'), '{"type":"user"}\n');

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

  await ctx.waitFor('FAKE_CLAUDE_UP');

  expect(ctx.read()).toInclude('--resume fake-1');
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
