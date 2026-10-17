import { readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildOwnDaemonProcess } from './build-own-daemon-process';
import { collectRestartEnv } from './collect-restart-env';
import type { DaemonProcess } from './daemon-process';
import { parseDaemonFlags } from './parse-daemon-flags';
import { readProcProcess } from './read-proc-process';

export function readDaemonProcess(pid: number, procRoot: string): DaemonProcess {
  const proc = readProcProcess(procRoot, pid);

  // an unreadable entry, as on macOS, falls back to this process's own start.
  if (proc === null) {
    return buildOwnDaemonProcess();
  }

  return {
    env: collectRestartEnv(proc.env),
    cwd: readCwd(procRoot, pid),
    flags: parseDaemonFlags(proc.args),
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
