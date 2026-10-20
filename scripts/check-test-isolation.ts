// Runs a test gate in a synthetic home of canary files and fails when the
// gate touches one; reads show only where access times update.
// Usage: bun scripts/check-test-isolation.ts [gate command...]
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// An access time older than the modification time is updated by the next
// read even on a relatime mount.
const CANARY_MTIME = new Date('2001-01-01T00:00:00Z');
const CANARY_ATIME = new Date('2000-01-01T00:00:00Z');

async function main(): Promise<void> {
  const gate = process.argv.length > 2 ? process.argv.slice(2) : ['bun', 'run', 'test'];
  const outer = mkdtempSync(join(tmpdir(), 'atc-canary-'));

  try {
    const home = join(outer, 'home');
    const run = join(outer, 'run');
    const canaries = buildCanaryPaths(home, run);

    writeCanaries(canaries, home, run);

    const watched = [
      join(home, '.local/state/atc'),
      join(home, '.config/atc'),
      join(home, '.config/git'),
      join(home, '.codex'),
      join(home, '.grok'),
      join(home, '.claude'),
      run,
    ];

    const before = readSnapshot(canaries, watched);

    const exitCode = await runGate(gate, home, run);

    if (exitCode !== 0) {
      process.exitCode = exitCode;

      return;
    }

    const after = readSnapshot(canaries, watched);
    const removed = before.filter((line) => !after.includes(line));
    const added = after.filter((line) => !before.includes(line));

    if (removed.length > 0 || added.length > 0) {
      console.error('test isolation: the gate reached the synthetic live home:');

      for (const line of removed) {
        console.error(`< ${line}`);
      }

      for (const line of added) {
        console.error(`> ${line}`);
      }

      process.exitCode = 1;

      return;
    }

    console.log(
      `test isolation: ${String(canaries.length)} canaries unchanged and unread after: ${gate.join(' ')}`,
    );
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
}

function buildCanaryPaths(home: string, run: string): readonly string[] {
  return [
    join(home, '.local/state/atc/hook-settings-zai.json'),
    join(home, '.local/state/atc/hook-settings-claude.json'),
    join(home, '.local/state/atc/atc-bridge/.claude-plugin/plugin.json'),
    join(home, '.local/state/atc/atc.db'),
    join(home, '.local/state/atc/status.json'),
    join(home, '.local/state/atc/mcp-auth.db'),
    join(home, '.config/atc/config.json'),
    join(home, '.config/git/config'),
    join(home, '.codex/session_index.jsonl'),
    join(home, '.codex/hooks.json'),
    join(home, '.grok/hooks/atc-reporter.json'),
    join(home, '.claude.json'),
    join(home, '.claude/settings.json'),
    join(run, 'atc-daemon.pid'),
  ];
}

function writeCanaries(canaries: readonly string[], home: string, run: string): void {
  for (const file of canaries) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `canary ${file}\n`);
  }

  // The git canary is a valid config, so a git that reads it runs on and
  // only its access time gives it away.
  writeFileSync(join(home, '.config/git/config'), '[atc]\n\tcanary = host\n');
  chmodSync(run, 0o700);

  for (const file of canaries) {
    utimesSync(file, CANARY_ATIME, CANARY_MTIME);
  }
}

// One line per canary, with its hash, modification time, and access time,
// then every path under the watched directories, sorted. Hashing reads each
// canary, so its access time is taken first and put back after.
function readSnapshot(canaries: readonly string[], watched: readonly string[]): string[] {
  const lines = canaries.map((file) => {
    if (!existsSync(file)) {
      return `${file} missing`;
    }

    const before = statSync(file);

    const hash = new Bun.CryptoHasher('sha256').update(readFileSync(file)).digest('hex');

    utimesSync(file, CANARY_ATIME, before.mtime);

    return `${file} ${hash} ${String(Math.floor(before.mtimeMs / 1000))} ${String(Math.floor(before.atimeMs / 1000))}`;
  });

  const paths = watched.flatMap((directory) =>
    existsSync(directory)
      ? readdirSync(directory, { recursive: true, encoding: 'utf8' }).map((path) =>
          join(directory, path),
        )
      : [],
  );

  return [...lines, ...paths.toSorted()];
}

function runGate(gate: readonly string[], home: string, run: string): Promise<number> {
  const { ATC_TEST_HOME: _testHome, ...inherited } = process.env;

  const env = {
    ...inherited,
    HOME: home,
    XDG_RUNTIME_DIR: run,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    GROK_HOME: join(home, '.grok'),
    CODEX_HOME: join(home, '.codex'),
    ATC_SESSION_ID: 's-canary',
    ATC_SOCKET: join(run, 'atc.sock'),
  };

  const subprocess = Bun.spawn([...gate], {
    cwd: join(import.meta.dir, '..'),
    env,
    stdio: ['inherit', 'inherit', 'inherit'],
  });

  return subprocess.exited;
}

await main();
