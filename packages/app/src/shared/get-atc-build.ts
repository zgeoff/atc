import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getBuild } from '@atc/config/get-build';
import pkg from '../../package.json';

// The packages folder of this checkout, each package's src tree under it.
const PACKAGES_DIR = join(import.meta.dir, '..', '..', '..');

/**
 * This atc's build identity: its version, stamped with the newest source
 * file across every workspace package of the checkout, or with the
 * compiled binary when there is no checkout to walk.
 */
export function getATCBuild(): string {
  return getBuild({ version: pkg.version, roots: collectSourceRoots() });
}

function collectSourceRoots(): string[] {
  try {
    return readdirSync(PACKAGES_DIR).map((name) => join(PACKAGES_DIR, name, 'src'));
  } catch {
    return [];
  }
}
