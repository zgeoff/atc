import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';

// Gives a test run its own home before any test imports atc. The package
// test scripts set it up before Bun starts and mark it with ATC_TEST_HOME;
// a bare `bun test` gets it here instead. Either way HOME, XDG_RUNTIME_DIR,
// GROK_HOME, and CODEX_HOME point under ATC_TEST_HOME, so config, state,
// the database, status file, daemon record, sockets, and agent homes all
// resolve there, and an enclosing session's ATC_SESSION_ID and ATC_SOCKET
// are dropped so no test reports to a live daemon.
const marker = process.env['ATC_TEST_HOME'];

if (marker === undefined) {
  const root = mkdtempSync(join(tmpdir(), 'atc-test-home-'));

  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'runtime'), { mode: 0o700 });

  process.env['ATC_TEST_HOME'] = root;
  process.env['HOME'] = join(root, 'home');
  process.env['XDG_RUNTIME_DIR'] = join(root, 'runtime');
  process.env['GROK_HOME'] = join(root, 'home', '.grok');
  process.env['CODEX_HOME'] = join(root, 'home', '.codex');
  delete process.env['ATC_SESSION_ID'];
  delete process.env['ATC_SOCKET'];

  process.on('exit', () => {
    rmSync(root, { recursive: true, force: true });
  });
} else {
  assertTestHome(marker);
}

// An inherited marker is trusted only when every isolated variable already
// points under it and no enclosing session's variables remain; a stale or
// hand-set marker stops the run before any test imports atc.
function assertTestHome(root: string): void {
  const expected: Readonly<Record<string, string>> = {
    HOME: join(root, 'home'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    GROK_HOME: join(root, 'home', '.grok'),
    CODEX_HOME: join(root, 'home', '.codex'),
  };

  const mismatched = Object.entries(expected)
    .filter(([name, path]) => normalize(process.env[name] ?? '') !== path)
    .map(([name]) => name);

  const leftover = ['ATC_SESSION_ID', 'ATC_SOCKET'].filter((name) => name in process.env);

  if (mismatched.length > 0 || leftover.length > 0) {
    throw new Error(
      `ATC_TEST_HOME is set to ${root} but ${[...mismatched, ...leftover].join(', ')} ` +
        'does not match the test home it marks; unset ATC_TEST_HOME or run the package test script',
    );
  }
}
