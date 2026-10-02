import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Gives a test run its own home before any test imports atc. The package
// test scripts set it up before Bun starts and mark it with ATC_TEST_HOME;
// a bare `bun test` gets it here instead. Either way HOME, XDG_RUNTIME_DIR,
// GROK_HOME, and CODEX_HOME point under ATC_TEST_HOME, so config, state,
// the database, status file, daemon record, sockets, and agent homes all
// resolve there, and an enclosing session's ATC_SESSION_ID and ATC_SOCKET
// are dropped so no test reports to a live daemon.
if (process.env['ATC_TEST_HOME'] === undefined) {
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
}
