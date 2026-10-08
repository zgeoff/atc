import { afterEach } from 'bun:test';
import { join, normalize } from 'node:path';
import { removeEnvOverrides } from './remove-env-overrides';

// Holds every test run to the isolated home the package test scripts set
// up before Bun starts, marked by ATC_TEST_HOME. A bare `bun test` stops
// here: Bun hands a spawned child the environment it started with, not one
// a preload changed, so only a home set before Bun starts reaches every
// subprocess a test runs. A run under a marker whose paths do not match it
// stops too. Both exit before any test imports atc. Once the home holds,
// every environment variable a test overrides through the shared helper is
// put back after that test, so the test home's own values return too.
const marker = process.env['ATC_TEST_HOME'];

if (marker === undefined) {
  stopRun('a bare `bun test` runs against your real home; run `bun run test` instead');
}

requireTestHome(marker);

afterEach(() => {
  removeEnvOverrides();
});

// An inherited marker is trusted only when every isolated variable already
// points under it and no enclosing session's variables remain; a stale or
// hand-set marker stops the run before any test imports atc. An inherited
// CLAUDE_CONFIG_DIR would move the Claude config folder out of the home.
function requireTestHome(root: string): void {
  const expected: Readonly<Record<string, string>> = {
    HOME: join(root, 'home'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    XDG_CONFIG_HOME: join(root, 'home', '.config'),
    XDG_DATA_HOME: join(root, 'home', '.local', 'share'),
    XDG_STATE_HOME: join(root, 'home', '.local', 'state'),
    XDG_CACHE_HOME: join(root, 'home', '.cache'),
    GROK_HOME: join(root, 'home', '.grok'),
    CODEX_HOME: join(root, 'home', '.codex'),
  };

  const mismatched = Object.entries(expected)
    .filter(([name, path]) => normalize(process.env[name] ?? '') !== path)
    .map(([name]) => name);

  const leftover = ['ATC_SESSION_ID', 'ATC_SOCKET', 'CLAUDE_CONFIG_DIR'].filter(
    (name) => name in process.env,
  );

  if (mismatched.length > 0 || leftover.length > 0) {
    stopRun(
      `ATC_TEST_HOME is set to ${root} but ${[...mismatched, ...leftover].join(', ')} ` +
        'does not match the test home it marks; unset ATC_TEST_HOME and run `bun run test`',
    );
  }
}

function stopRun(message: string): never {
  console.error(`test home: ${message}`);
  process.exit(2);
}
