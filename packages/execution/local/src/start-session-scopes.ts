import { readFileSync } from 'node:fs';
import { parseSystemdUnit } from '@atc/core/parse-systemd-unit';
import { SessionScopes } from './session-scopes';

/**
 * The scopes the daemon's harnesses start in, or null when the daemon is
 * not the main process of a user service. The daemon's cgroup is read from
 * `cgroupPath`. The scopes that an earlier daemon in the service left
 * behind are stopped in the background.
 *
 * Two facts make the daemon a service's main process: its cgroup sits in a
 * `<name>.service` below the user manager, and `SYSTEMD_EXEC_PID`, which
 * systemd sets for the process it starts, holds the daemon's own pid. A
 * daemon started from a shell or a test, or from a session inside a
 * service, fails one or the other, and its harnesses start as its plain
 * children. `systemctl` and `systemd-run` are found on the daemon's PATH.
 */
export function startSessionScopes(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cgroupPath = '/proc/self/cgroup',
  pid = process.pid,
): SessionScopes | null {
  const uid = process.getuid?.();

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
  const path = { PATH: env['PATH'] ?? '' };
  const systemctl = Bun.which('systemctl', path);
  const systemdRun = Bun.which('systemd-run', path);

  if (unit === null || systemctl === null || systemdRun === null) {
    return null;
  }

  const scopes = new SessionScopes({ unit, systemctl, systemdRun });

  void scopes.stopLeftovers();

  return scopes;
}
