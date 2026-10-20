import { readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { collectRestartEnv } from './collect-restart-env';
import type { DaemonProcess } from './daemon-process';
import { parseDaemonFlags } from './parse-daemon-flags';
import { readOwnDaemonProcess } from './read-own-daemon-process';
import { readProcProcess } from './read-proc-process';

export function readDaemonProcess(pid: number, procRoot: string): DaemonProcess {
  const subprocess = readProcProcess(procRoot, pid);

  // an unreadable entry, as on macOS, falls back to this process's own start.
  if (subprocess === null) {
    return readOwnDaemonProcess();
  }

  return {
    env: collectRestartEnv(subprocess.env),
    cwd: readCwd(procRoot, pid),
    flags: parseDaemonFlags(subprocess.args),
    fromProc: true,
  };
}

function readCwd(procRoot: string, pid: number): string | null {
  try {
    const cwd = readlinkSync(join(procRoot, String(pid), 'cwd'));

    return statSync(cwd).isDirectory() ? cwd : null;
  } catch {
    return null;
  }
}
