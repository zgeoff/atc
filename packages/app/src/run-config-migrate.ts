import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { systemClock } from '@atc/core';
import { buildMigratedConfig } from './build-migrated-config';
import { PROCESS_IO } from './process-io';
import type { ProcessIO } from './process-io';

interface ConfigMigrateIO extends Pick<ProcessIO, 'print' | 'printError'> {
  readonly printText: (text: string) => void;
}

const CONFIG_MIGRATE_IO: ConfigMigrateIO = {
  ...PROCESS_IO,
  printText: (text) => {
    process.stdout.write(text);
  },
};

export function runConfigMigrate(
  file: string,
  write: boolean,
  io: ConfigMigrateIO = CONFIG_MIGRATE_IO,
): number {
  let text: string;

  try {
    text = readFileSync(file, 'utf8');
  } catch {
    io.printError(`atc config migrate: ${file} cannot be read`);

    return 1;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    io.printError(`atc config migrate: ${file} is not valid JSON`);

    return 1;
  }

  const result = buildMigratedConfig(raw);

  if (result.kind === 'unusable') {
    io.printError(`atc config migrate: ${file}: ${result.detail}`);

    return 1;
  }

  if (result.kind === 'current') {
    io.print('config.json already uses agents; nothing to migrate');

    return 0;
  }

  for (const note of result.notes) {
    io.printError(note);
  }

  if (!write) {
    io.printText(result.text);

    return 0;
  }

  const backup = `${file}.bak-${formatBackupStamp(systemClock.now())}`;

  try {
    copyFileSync(file, backup);
  } catch {
    io.printError(`atc config migrate: ${backup} cannot be written; ${file} is unchanged`);

    return 1;
  }

  try {
    writeFileSync(file, result.text);
  } catch {
    io.printError(`atc config migrate: ${file} cannot be written; the backup is at ${backup}`);

    return 1;
  }

  io.print(`backup: ${backup}`);
  io.print(`wrote: ${file}`);

  return 0;
}

// A UTC time as `20261006T152200Z`.
function formatBackupStamp(time: number): string {
  return new Date(time)
    .toISOString()
    .replaceAll(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z');
}
