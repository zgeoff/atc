import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { buildMigratedConfig } from './build-migrated-config';

/**
 * Runs `atc config migrate`: prints the config.json rewritten around
 * `agents`, or with `write` copies the file to a timestamped backup beside it
 * and rewrites it in place. Returns the exit code. Notes and problems go to
 * stderr and name keys and paths, never values.
 */
export function runConfigMigrate(file: string, write: boolean): number {
  let text: string;

  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.error(`atc config migrate: ${file} cannot be read`);

    return 1;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    console.error(`atc config migrate: ${file} is not valid JSON`);

    return 1;
  }

  const result = buildMigratedConfig(raw);

  if (result.kind === 'unusable') {
    console.error(`atc config migrate: ${file}: ${result.detail}`);

    return 1;
  }

  if (result.kind === 'current') {
    console.log('config.json already uses agents; nothing to migrate');

    return 0;
  }

  for (const note of result.notes) {
    console.error(note);
  }

  if (!write) {
    process.stdout.write(result.text);

    return 0;
  }

  const backup = `${file}.bak-${formatBackupStamp(Date.now())}`;

  try {
    copyFileSync(file, backup);
  } catch {
    console.error(`atc config migrate: ${backup} cannot be written; ${file} is unchanged`);

    return 1;
  }

  try {
    writeFileSync(file, result.text);
  } catch {
    console.error(`atc config migrate: ${file} cannot be written; the backup is at ${backup}`);

    return 1;
  }

  console.log(`backup: ${backup}`);
  console.log(`wrote: ${file}`);

  return 0;
}

// A UTC time as `20261006T152200Z`.
function formatBackupStamp(time: number): string {
  return new Date(time)
    .toISOString()
    .replaceAll(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z');
}
