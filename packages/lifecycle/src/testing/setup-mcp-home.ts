import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config';
import { systemClock } from '@atc/core';
import {
  buildStubMCPClaude,
  buildStubMCPGrok,
  createStubBin,
  readSourceEntry,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { readPidFilePID } from '../read-pid-file-pid';
import { stopDaemonProcess } from '../stop-daemon-process';

export function setupMCPHome() {
  const temporaryDirectory = setupTempDir('atc-mcp-');

  // Registered after the home, so it releases first: the daemon and the
  // stand-ins stop before the home that records them is removed.
  const stack = new AsyncDisposableStack();

  const teardown = registerTestCleanup(() => stack.disposeAsync());

  stack.defer(temporaryDirectory.teardown);

  const home = temporaryDirectory.path;

  // The server and the daemon it starts run with the home as their HOME and XDG_RUNTIME_DIR.
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
