import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isCompiledBinary, readBuild } from '@atc/config/host';
import { runCommand } from '@atc/lifecycle/run-command';
import type { HostServices } from '@atc/plugin-api';
import { systemClock } from '@zgeoff/std';
import pkg from '../../package.json';

interface HostServicesOptions {
  readonly log?: (line: string) => void;

  readonly compiled?: boolean;
}

export function createHostServices(options: HostServicesOptions = {}): HostServices {
  const compiled = options.compiled ?? isCompiledBinary();

  return {
    atcArgv: compiled
      ? [process.execPath]
      : [process.execPath, join(import.meta.dir, '..', 'cli.ts')],
    version: pkg.version,

    // a getter, so a long-lived process that a rebuild overtakes reads the new
    // stamp
    get build() {
      return readBuild({ version: pkg.version, roots: readSourceRoots() });
    },
    runCommand,
    clock: systemClock,
    log:
      options.log ??
      ((line) => {
        console.error(line);
      }),
  };
}

// Each package's src tree sits one folder below this, or two for a package inside a group folder.
const PACKAGES_DIR = join(import.meta.dir, '..', '..', '..');

function readSourceRoots(): string[] {
  try {
    return readdirSync(PACKAGES_DIR).flatMap((name) => {
      const directory = join(PACKAGES_DIR, name);

      return existsSync(join(directory, 'package.json'))
        ? [join(directory, 'src')]
        : readdirSync(directory).map((child) => join(directory, child, 'src'));
    });
  } catch {
    return [];
  }
}
