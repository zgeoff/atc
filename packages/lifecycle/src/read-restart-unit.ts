import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSystemdUnit } from '@atc/core';
import type { LifecycleHost } from './lifecycle-host';

// the cgroup alone proves nothing: a process can sit in the unit's cgroup
// without being the process the unit runs, so `MainPID` must match too.
export async function readRestartUnit(
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
