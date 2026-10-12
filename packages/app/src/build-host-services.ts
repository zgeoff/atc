import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getBuild } from '@atc/config/get-build';
import { systemClock } from '@atc/core/system-clock';
import { runCommand } from '@atc/lifecycle/run-command';
import type { HostServices } from '@atc/plugin-api/host-services';
import pkg from '../package.json';
import { buildCLIArgv } from './agents/build-cli-argv';

// The packages folder of this checkout. Each package's src tree sits under
// it, one folder deep or, for a package in a group folder, two.
const PACKAGES_DIR = join(import.meta.dir, '..', '..');

/**
 * The host services of this atc process: the argv that runs its CLI, its
 * release version, the wall clock, the machine's commands, and `log` for
 * its log lines. The build is read again on every access, stamped with the
 * newest source file across every workspace package of the checkout or
 * with the compiled binary, so a long-lived process that a rebuild
 * overtakes reads the new stamp.
 */
export function buildHostServices(
  log: (line: string) => void = (line) => {
    console.error(line);
  },
): HostServices {
  return {
    atcArgv: buildCLIArgv(),
    version: pkg.version,
    get build() {
      return getBuild({ version: pkg.version, roots: collectSourceRoots() });
    },
    runCommand,
    clock: systemClock,
    log,
  };
}

function collectSourceRoots(): string[] {
  try {
    return readdirSync(PACKAGES_DIR).flatMap((name) => {
      const dir = join(PACKAGES_DIR, name);

      return existsSync(join(dir, 'package.json'))
        ? [join(dir, 'src')]
        : readdirSync(dir).map((child) => join(dir, child, 'src'));
    });
  } catch {
    return [];
  }
}
