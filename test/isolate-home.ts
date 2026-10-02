import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Points $HOME and $XDG_RUNTIME_DIR at a throwaway directory for the whole
// run, before any test imports atc, so config, state, the database, status
// file, daemon record, lock, and sockets all resolve under it and no test
// reads or writes the user's own. A run started inside an atc session drops
// the session's id and reporter socket, so no test reports to the live
// daemon. Subprocesses inherit the same environment.
const root = mkdtempSync(join(tmpdir(), 'atc-test-home-'));
const home = join(root, 'home');
const runtime = join(root, 'runtime');

mkdirSync(home);
mkdirSync(runtime, { mode: 0o700 });

process.env['HOME'] = home;
process.env['XDG_RUNTIME_DIR'] = runtime;
delete process.env['ATC_SESSION_ID'];
delete process.env['ATC_SOCKET'];

process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
});
