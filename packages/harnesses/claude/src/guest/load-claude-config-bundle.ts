import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { GuestFile } from '@atc/plugin-api';
import { resolveHomeDir } from '@atcx/contract/light';
import { buildClaudeBundleSettings } from './build-claude-bundle-settings';

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

function readSettings(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function buildHostDirSpellings(hostDir: string, homeDir: string): string[] {
  return hostDir === join(homeDir, '.claude') ? [hostDir, '~/.claude', '$HOME/.claude'] : [hostDir];
}

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

function probeShippedFile(path: string, hostReal: string): boolean {
  const real = realpathSync(path);

  if (basename(real).startsWith('.')) {
    return false;
  }

  const inside = relative(hostReal, real);

  return inside.startsWith('..') || SHIPPED_ENTRIES.has(inside.split(sep)[0] ?? '');
}

function readBundleFile(path: string, mode: number): GuestFile {
  const content = readFileSync(path);

  return (mode & 0o100) === 0 ? content : { content, mode: 0o755 };
}

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

function readEntryNames(directory: string): string[] {
  if (readStats(directory)?.isDirectory() !== true) {
    return [];
  }

  return readdirSync(directory)
    .filter((name) => !name.startsWith('.'))
    .toSorted();
}
