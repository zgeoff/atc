import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { resolveHomeDir } from '../shared/resolve-home-dir';
import type { GuestFile } from './agent-adapter';
import { buildClaudeBundleSettings } from './build-claude-bundle-settings';

/**
 * The files of the Claude config bundle, read from the host's config folder
 * `hostDir` and keyed by their path inside the guest's config folder
 * `guestDir`: `CLAUDE.md`, the filtered `settings.json`, `statusline.sh`,
 * every file under `agents/` and `output-styles/`, and each folder under
 * `skills/` that holds a `SKILL.md`. Symlinks resolve to copies of what
 * they point at, and a file its owner may execute unpacks executable.
 * Nothing else in the host's folder ships, so its account state, history,
 * credentials, and backups stay there, and so does any entry whose name
 * starts with a dot. A symlink ships only when what it resolves to could
 * ship by its own path: a file whose name starts with a dot never does, and
 * neither does a file in the host's folder outside the shipped entries. A
 * missing entry ships nothing. `homeDir` is the user's home, which decides
 * whether the host folder is the default one.
 */
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

  const hostReal = findStats(hostDir) === null ? hostDir : realpathSync(hostDir);

  for (const name of ['CLAUDE.md', 'statusline.sh']) {
    const path = join(hostDir, name);
    const stats = findStats(path);

    if (stats?.isFile() === true && shouldShipFile(path, hostReal)) {
      files[name] = readBundleFile(path, stats.mode);
    }
  }

  for (const name of ['agents', 'output-styles']) {
    Object.assign(files, collectTreeFiles(join(hostDir, name), name, hostReal, new Set()));
  }

  const skills = join(hostDir, 'skills');

  for (const name of readEntryNames(skills)) {
    const path = join(skills, name);

    if (findStats(join(path, 'SKILL.md'))?.isFile() === true) {
      Object.assign(files, collectTreeFiles(path, `skills/${name}`, hostReal, new Set()));
    }
  }

  return files;
}

// The ways a command can spell the host's config folder: its path, and
// when it is the default folder in the user's home, the home-relative forms
// a shell expands.
function buildHostDirSpellings(hostDir: string, homeDir: string): string[] {
  return hostDir === join(homeDir, '.claude') ? [hostDir, '~/.claude', '$HOME/.claude'] : [hostDir];
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

// Every file under `dir` that may ship, keyed by its path under `prefix`,
// with symlinks followed. `seen` holds the real paths of the folders on the
// way down, so a symlink back up the tree ends there.
function collectTreeFiles(
  dir: string,
  prefix: string,
  hostReal: string,
  seen: ReadonlySet<string>,
): Record<string, GuestFile> {
  const real = findStats(dir) === null ? null : realpathSync(dir);

  if (real === null || seen.has(real)) {
    return {};
  }

  const below = new Set([...seen, real]);

  const files: Record<string, GuestFile> = {};

  for (const name of readEntryNames(dir)) {
    const path = join(dir, name);
    const stats = findStats(path);

    if (stats?.isFile() === true && shouldShipFile(path, hostReal)) {
      files[`${prefix}/${name}`] = readBundleFile(path, stats.mode);
    } else if (stats?.isDirectory() === true) {
      Object.assign(files, collectTreeFiles(path, `${prefix}/${name}`, hostReal, below));
    }
  }

  return files;
}

// Whether the file a path resolves to may ship: its name starts with no
// dot, and inside the host's real folder `hostReal` it sits in a shipped
// entry, so a symlink never carries credentials, account state, or the
// unfiltered settings.
function shouldShipFile(path: string, hostReal: string): boolean {
  const real = realpathSync(path);

  if (basename(real).startsWith('.')) {
    return false;
  }

  const inside = relative(hostReal, real);

  return inside.startsWith('..') || SHIPPED_ENTRIES.has(inside.split(sep)[0] ?? '');
}

const SHIPPED_ENTRIES: ReadonlySet<string> = new Set([
  'CLAUDE.md',
  'statusline.sh',
  'agents',
  'output-styles',
  'skills',
]);

// A file's bytes, with an executable mode when its owner may execute it.
function readBundleFile(path: string, mode: number): GuestFile {
  const content = readFileSync(path);

  return (mode & 0o100) === 0 ? content : { content, mode: 0o755 };
}
