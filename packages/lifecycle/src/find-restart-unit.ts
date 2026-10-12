import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LifecycleHost } from './lifecycle-host';
import { parseSystemdUnit } from './parse-systemd-unit';

/**
 * The user service whose main process is the daemon with this pid, or null
 * when the daemon is not one.
 *
 * Two facts must hold. The daemon's cgroup sits in a `<name>.service` below
 * the user manager, and the manager reports that unit's `MainPID` as this
 * pid. The cgroup alone proves nothing: every process started from a
 * session inside the unit, such as a daemon a test starts, shares the
 * unit's cgroup without being the process the unit runs. The cgroup is read
 * under the host's `/proc`, and the manager is asked through its
 * `systemctl`.
 */
export async function findRestartUnit(
  pid: number,
  host: Pick<LifecycleHost, 'procRoot' | 'runSystemctl'>,
): Promise<string | null> {
  const uid = process.getuid?.();

  if (uid === undefined) {
    return null;
  }

  let cgroup: string;

  try {
    cgroup = readFileSync(join(host.procRoot, String(pid), 'cgroup'), 'utf8');
  } catch {
    return null;
  }

  const unit = parseSystemdUnit(cgroup, uid);

  if (unit === null) {
    return null;
  }

  const shown = await host.runSystemctl(['show', '-p', 'MainPID', '--value', unit]);

  return shown.code === 0 && shown.stdout === String(pid) ? unit : null;
}
