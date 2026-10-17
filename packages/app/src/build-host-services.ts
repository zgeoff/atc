import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getBuild, isCompiledBinary } from '@atc/config/host';
import { systemClock } from '@atc/core';
import { runCommand } from '@atc/lifecycle/run-command';
import type { HostServices } from '@atc/plugin-api';
import pkg from '../package.json';

// The packages folder of this checkout. Each package's src tree sits under
// it, one folder deep or, for a package in a group folder, two.
const PACKAGES_DIR = join(import.meta.dir, '..', '..');

interface HostServicesOptions {
  // Where log lines go: stderr by default.
  readonly log?: (line: string) => void;

  // Whether this process runs as a compiled binary: detected by default.
  readonly compiled?: boolean;
}

export function buildHostServices(options: HostServicesOptions = {}): HostServices {
  const compiled = options.compiled ?? isCompiledBinary();

  return {
    atcArgv: compiled ? [process.execPath] : [process.execPath, join(import.meta.dir, 'cli.ts')],
    version: pkg.version,

    // a getter, so a long-lived process that a rebuild overtakes reads the new
    // stamp
    get build() {
      return getBuild({ version: pkg.version, roots: collectSourceRoots() });
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
