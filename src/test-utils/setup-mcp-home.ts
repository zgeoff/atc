import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findPidFilePID } from '../shared/find-pid-file-pid';
import { stopDaemonProcess } from '../stop-daemon-process';
import { buildStubMCPClaude } from './build-stub-mcp-claude';
import { buildStubMCPGrok } from './build-stub-mcp-grok';
import { createStubBin } from './create-stub-bin';
import { setupTempDir } from './setup-temp-dir';

/**
 * A temp home for running `atc mcp` against, with the stand-in `claude` and
 * `grok` at `claudeBin` and `grokBin` and a config that registers them with
 * no extra arguments. A server started with this home as its `HOME` and
 * `XDG_RUNTIME_DIR` boots its daemon here. Disposal stops that daemon, when
 * one wrote its pid file here, waits for it to exit, then removes the home;
 * hold the result with `await using`.
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

      tmp[Symbol.dispose]();
    },
  };
}
