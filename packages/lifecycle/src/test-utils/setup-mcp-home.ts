import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config';
import { systemClock } from '@atc/core';
import { createStubBin } from '@atc/core/test-utils/create-stub-bin';
import { readSourceEntry } from '@atc/core/test-utils/read-source-entry';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { readPidFilePID } from '../daemon-files/read-pid-file-pid';
import { stopDaemonProcess } from '../daemon-process/stop-daemon-process';
import { buildStubMCPClaude } from './build-stub-mcp-claude';
import { buildStubMCPGrok } from './build-stub-mcp-grok';

export function setupMCPHome() {
  const temporaryDirectory = setupTempDir('atc-mcp-');

  const stack = new AsyncDisposableStack();

  const teardown = registerTestCleanup(() => stack.disposeAsync());

  stack.defer(temporaryDirectory.teardown);

  const home = temporaryDirectory.path;
  const paths = resolvePaths({ HOME: home, XDG_RUNTIME_DIR: home });

  stack.defer(async () => {
    const pid = readPidFilePID(paths.daemonPidFile);

    if (pid !== null) {
      await stopDaemonProcess(pid, systemClock);
    }

    await killProcessGroups([...(pid === null ? [] : [pid]), ...readStubPIDs(home)]);
  });

  mkdirSync(join(home, '.config', 'atc'), { recursive: true });
  mkdirSync(paths.stateDir, { recursive: true });

  const claudeBin = createStubBin(home, 'fake-claude', buildStubMCPClaude(readSourceEntry('atc')));
  const grokBin = createStubBin(home, 'fake-grok', buildStubMCPGrok(readSourceEntry('atc')));

  writeFileSync(
    join(home, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { kind: 'claude', bin: claudeBin },
        grok: { kind: 'grok', bin: grokBin },
        codex: { kind: 'codex' },
      },
    }),
  );

  return {
    home,
    paths,
    claudeBin,
    grokBin,
    teardown,
  };
}

async function killProcessGroups(groups: readonly number[]): Promise<void> {
  for (const group of groups) {
    try {
      process.kill(-group, 'SIGKILL');
    } catch {}
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
