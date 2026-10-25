import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { GuestFile } from '@atc/plugin-api';
import { resolveHomeDir } from '@atcx/contract/light';
import { buildClaudeBundleSettings } from './build-claude-bundle-settings';

// only the listed entries ship, so the host's account state, history, credentials, backups and
// dot-entries stay there
export function loadClaudeConfigBundle(
  hostDir: string,
  guestDir: string,
  homeDir: string = resolveHomeDir(),
): Record<string, GuestFile> {
  const hostSettings = readSettings(join(hostDir, 'settings.json'));

  const settings = buildClaudeBundleSettings(
    hostSettings,
    buildHostDirSpellings(hostDir, homeDir),
    guestDir,
  );

  const files: Record<string, GuestFile> = {
    'settings.json': JSON.stringify(settings, null, 2),
  };

  const hostReal = readStats(hostDir) === null ? hostDir : realpathSync(hostDir);

  for (const name of ['CLAUDE.md', 'statusline.sh']) {
    const path = join(hostDir, name);
    const stats = readStats(path);

    if (stats?.isFile() === true && probeShippedFile(path, hostReal)) {
      files[name] = readBundleFile(path, stats.mode);
    }
  }

  for (const name of ['agents', 'output-styles']) {
    Object.assign(files, readTreeFiles(join(hostDir, name), name, hostReal, new Set()));
  }

  const skills = join(hostDir, 'skills');

  for (const name of readEntryNames(skills)) {
    const path = join(skills, name);

    if (readStats(join(path, 'SKILL.md'))?.isFile() === true) {
      Object.assign(files, readTreeFiles(path, `skills/${name}`, hostReal, new Set()));
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

// The ways a command can spell the host's config folder: its path, and
// when it is the default folder in the user's home, the home-relative forms
// a shell expands.
function buildHostDirSpellings(hostDir: string, homeDir: string): string[] {
  return hostDir === join(homeDir, '.claude') ? [hostDir, '~/.claude', '$HOME/.claude'] : [hostDir];
}

// The stats of what a path resolves to, or null for a missing path or a
// symlink that points nowhere.
function readStats(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

const SHIPPED_ENTRIES: ReadonlySet<string> = new Set([
  'CLAUDE.md',
  'statusline.sh',
  'agents',
  'output-styles',
  'skills',
]);

// a symlink ships only when its target could ship by its own path, so it never carries
// credentials, account state, or the unfiltered settings
function probeShippedFile(path: string, hostReal: string): boolean {
  const real = realpathSync(path);

  if (basename(real).startsWith('.')) {
    return false;
  }

  const inside = relative(hostReal, real);

  return inside.startsWith('..') || SHIPPED_ENTRIES.has(inside.split(sep)[0] ?? '');
}

// A file's bytes, with an executable mode when its owner may execute it.
function readBundleFile(path: string, mode: number): GuestFile {
  const content = readFileSync(path);

  return (mode & 0o100) === 0 ? content : { content, mode: 0o755 };
}

// Every file under `dir` that may ship, keyed by its path under `prefix`,
// with symlinks followed. `seen` holds the real paths of the folders on the
// way down, so a symlink back up the tree ends there.
function readTreeFiles(
  directory: string,
  prefix: string,
  hostReal: string,
  seen: ReadonlySet<string>,
): Record<string, GuestFile> {
  const real = readStats(directory) === null ? null : realpathSync(directory);

  if (real === null || seen.has(real)) {
    return {};
  }

  const below = new Set([...seen, real]);

  const files: Record<string, GuestFile> = {};

  for (const name of readEntryNames(directory)) {
    const path = join(directory, name);
    const stats = readStats(path);

    if (stats?.isFile() === true && probeShippedFile(path, hostReal)) {
      files[`${prefix}/${name}`] = readBundleFile(path, stats.mode);
    } else if (stats?.isDirectory() === true) {
      Object.assign(files, readTreeFiles(path, `${prefix}/${name}`, hostReal, below));
    }
  }

  return files;
}

// A folder's entry names, sorted, without the ones that start with a dot,
// or none when the path is not a folder.
function readEntryNames(directory: string): string[] {
  if (readStats(directory)?.isDirectory() !== true) {
    return [];
  }

  return readdirSync(directory)
    .filter((name) => !name.startsWith('.'))
    .toSorted();
}
