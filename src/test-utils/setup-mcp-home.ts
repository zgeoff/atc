import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPidFilePID } from '../shared/find-pid-file-pid';
import { stopDaemonProcess } from '../stop-daemon-process';
import { buildStubMCPClaude } from './build-stub-mcp-claude';
import { buildStubMCPGrok } from './build-stub-mcp-grok';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

/**
 * A temp home for running `atc mcp` against, with the stand-in `claude` and
 * `grok` at `claudeBin` and `grokBin` and a config that registers them with
 * no extra arguments. A server started with this home as its `HOME` and
 * `XDG_RUNTIME_DIR` boots its daemon here. Disposal stops that daemon, when
 * one wrote its pid file here, and waits for it to exit; then it kills every
 * process still running with this home as its `HOME`, such as a reporter a
 * stopped session left behind, waits for those to exit, and removes the
 * home. Hold the result with `await using`.
 */
export function setupMCPHome() {
  const tmp = setupTempDir('atc-mcp-');
  const home = tmp.dir;

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
    async [Symbol.asyncDispose]() {
      const pid = findPidFilePID(join(home, 'atc-daemon.pid'));

      if (pid !== null) {
        await stopDaemonProcess(pid);
      }

      await killHomeProcesses(home);

      tmp[Symbol.dispose]();
    },
  };
}

async function killHomeProcesses(home: string): Promise<void> {
  for (const pid of collectHomePIDs(home)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process exited after the scan read it.
    }
  }

  await waitFor(() => {
    const running = collectHomePIDs(home);

    if (running.length > 0) {
      throw new Error(`processes still running with home ${home}: ${running.join(', ')}`);
    }
  });
}

/**
 * The pids of the running processes whose environment sets `HOME` to the
 * home. A process that exits while the scan reads it is left out.
 */
function collectHomePIDs(home: string): number[] {
  const entry = `HOME=${home}`;

  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .filter((name) => {
      try {
        return readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').includes(entry);
      } catch {
        return false;
      }
    })
    .map(Number);
}
