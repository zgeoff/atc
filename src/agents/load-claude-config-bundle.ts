import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeBundleSettings } from './build-claude-bundle-settings';

/**
 * The files of the Claude config bundle, read from the host's config folder
 * `hostDir` and keyed by their path inside the guest's config folder
 * `guestDir`: `CLAUDE.md`, the filtered `settings.json`, `statusline.sh`,
 * every file under `agents/` and `output-styles/`, and each folder under
 * `skills/` that holds a `SKILL.md`. Symlinks resolve to copies of what
 * they point at. Nothing else in the host's folder ships, so its account
 * state, history, credentials, and backups stay there, and so does any
 * entry whose name starts with a dot. A missing entry ships nothing.
 */
export function loadClaudeConfigBundle(
  hostDir: string,
  guestDir: string,
): Record<string, Uint8Array | string> {
  const hostSettings = readSettings(join(hostDir, 'settings.json'));
  const settings = buildClaudeBundleSettings(hostSettings, hostDir, guestDir);

  const files: Record<string, Uint8Array | string> = {
    'settings.json': JSON.stringify(settings, null, 2),
  };

  for (const name of ['CLAUDE.md', 'statusline.sh']) {
    const path = join(hostDir, name);

    if (findStats(path)?.isFile() === true) {
      files[name] = readFileSync(path);
    }
  }

  for (const name of ['agents', 'output-styles']) {
    Object.assign(files, collectTreeFiles(join(hostDir, name), name, new Set()));
  }

  const skills = join(hostDir, 'skills');

  for (const name of readEntryNames(skills)) {
    const path = join(skills, name);

    if (findStats(join(path, 'SKILL.md'))?.isFile() === true) {
      Object.assign(files, collectTreeFiles(path, `skills/${name}`, new Set()));
    }
  }

  return files;
}

// The host's settings, or none when the file is missing or is not JSON,
// which still ships the auto-mode default.
function readSettings(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// The stats of what a path resolves to, or null for a missing path or a
// symlink that points nowhere.
function findStats(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

// A folder's entry names, sorted, without the ones that start with a dot,
// or none when the path is not a folder.
function readEntryNames(dir: string): string[] {
  if (findStats(dir)?.isDirectory() !== true) {
    return [];
  }

  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .toSorted();
}

// Every file under `dir`, keyed by its path under `prefix`, with symlinks
// followed. `seen` holds the real paths of the folders on the way down, so
// a symlink back up the tree ends there.
function collectTreeFiles(
  dir: string,
  prefix: string,
  seen: ReadonlySet<string>,
): Record<string, Uint8Array> {
  const real = findStats(dir) === null ? null : realpathSync(dir);

  if (real === null || seen.has(real)) {
    return {};
  }

  const below = new Set([...seen, real]);

  const files: Record<string, Uint8Array> = {};

  for (const name of readEntryNames(dir)) {
    const path = join(dir, name);
    const stats = findStats(path);

    if (stats?.isFile() === true) {
      files[`${prefix}/${name}`] = readFileSync(path);
    } else if (stats?.isDirectory() === true) {
      Object.assign(files, collectTreeFiles(path, `${prefix}/${name}`, below));
    }
  }

  return files;
}
