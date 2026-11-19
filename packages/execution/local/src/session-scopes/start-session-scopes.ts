import { readFileSync } from 'node:fs';
import { parseSystemdUnit } from '@atc/core';
import { createSessionScopes } from './create-session-scopes';
import type { SessionScopes } from './create-session-scopes';
import { readSystemdVersion } from './read-systemd-version';

// The first systemd release whose `systemd-run` takes
// `--expand-environment`.
const EXPAND_ENVIRONMENT_RELEASE = 254;

export function startSessionScopes(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cgroupPath = '/proc/self/cgroup',
  pid = process.pid,
): SessionScopes | null {
  const uid = process.getuid?.();

  // systemd sets SYSTEMD_EXEC_PID to the pid of the process it starts, so only
  // the service's main process starts its harnesses in scopes.
  if (uid === undefined || env['SYSTEMD_EXEC_PID'] !== String(pid)) {
    return null;
  }

  let cgroup: string;

  try {
    cgroup = readFileSync(cgroupPath, 'utf8');
  } catch {
    return null;
  }

  const unit = parseSystemdUnit(cgroup, uid);
  const invocation = env['INVOCATION_ID'] ?? '';
  const path = { PATH: env['PATH'] ?? '' };
  const systemctl = Bun.which('systemctl', path);
  const systemdRun = Bun.which('systemd-run', path);

  if (
    unit === null ||
    invocation === '' ||
    systemctl === null ||
    systemdRun === null ||
    (readSystemdVersion(systemdRun) ?? 0) < EXPAND_ENVIRONMENT_RELEASE
  ) {
    return null;
  }

  const scopes = createSessionScopes({ unit, run: invocation.slice(0, 8), systemctl, systemdRun });

  void scopes.stopLeftovers();

  return scopes;
}
