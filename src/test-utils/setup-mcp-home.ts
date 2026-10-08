import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPidFilePID } from '../shared/find-pid-file-pid';
import { stopDaemonProcess } from '../stop-daemon-process';
import { buildStubMCPClaude } from './build-stub-mcp-claude';
import { buildStubMCPGrok } from './build-stub-mcp-grok';
import { createStubBin } from './create-stub-bin';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

/**
 * A temp home for running `atc mcp` against, with the stand-in `claude` and
 * `grok` at `claudeBin` and `grokBin` and a config that registers them with
 * no extra arguments. A server started with this home as its `HOME` and
 * `XDG_RUNTIME_DIR` boots its daemon here. Each stand-in appends its pid,
 * which is its process group as a session leader, to `stub-pids` in the
 * home. Disposal stops the daemon, when one wrote its pid file here, and
 * waits for it to exit; then it kills the daemon's process group and every
 * group `stub-pids` records, such as a reporter a stopped session left
 * behind, waits until each group is empty, and removes the home. That
 * disposal runs once the current test finishes, so it must run inside a
 * test; disposing sooner runs it then, and a second disposal does nothing.
 */
export function setupMCPHome() {
  // The daemon and the stand-ins stop before the home that records them is
  // removed.
  const stack = new AsyncDisposableStack();

  const dispose = registerTestCleanup(() => stack.disposeAsync());
  const tmp = stack.use(setupTempDir('atc-mcp-'));
  const home = tmp.dir;

  stack.defer(async () => {
    const pid = findPidFilePID(join(home, 'atc-daemon.pid'));

    if (pid !== null) {
      await stopDaemonProcess(pid);
    }

    await killProcessGroups([...(pid === null ? [] : [pid]), ...readStubPIDs(home)]);
  });

  mkdirSync(join(home, '.config', 'atc'), { recursive: true });
  mkdirSync(join(home, '.local', 'state', 'atc'), { recursive: true });

  const claudeBin = createStubBin(home, 'fake-claude', buildStubMCPClaude());
  const grokBin = createStubBin(home, 'fake-grok', buildStubMCPGrok());

  writeFileSync(
    join(home, '.config', 'atc', 'config.json'),
    JSON.stringify({ claudeBin, claudeArgs: [], grokBin, grokArgs: [] }),
  );

  return {
    home,
    claudeBin,
    grokBin,
    [Symbol.asyncDispose]: dispose,
  };
}

/**
 * The pids the stand-ins recorded in the home, one per line; none when no
 * stand-in ran.
 */
function readStubPIDs(home: string): number[] {
  const path = join(home, 'stub-pids');

  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map(Number);
}

async function killProcessGroups(groups: readonly number[]): Promise<void> {
  for (const group of groups) {
    try {
      process.kill(-group, 'SIGKILL');
    } catch {
      // The group is already empty.
    }
  }

  await waitFor(() => {
    const running = groups.filter((group) => isProcessGroupRunning(group));

    if (running.length > 0) {
      throw new Error(`process groups still running: ${running.join(', ')}`);
    }
  });
}

function isProcessGroupRunning(group: number): boolean {
  try {
    process.kill(-group, 0);

    return true;
  } catch (error) {
    return !(error instanceof Error && Reflect.get(error, 'code') === 'ESRCH');
  }
}
