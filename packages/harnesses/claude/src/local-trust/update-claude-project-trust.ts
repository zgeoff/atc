import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isRecord } from '@atc/core';
import { z } from 'zod';
import { withClaudeConfigLock } from './with-claude-config-lock';
import type { ClaudeConfigLockOptions } from './with-claude-config-lock';

const TrustedEntrySchema = z.looseObject({ hasTrustDialogAccepted: z.literal(true) });

export async function updateClaudeProjectTrust(
  configPath: string,
  root: string,
  lockOptions: ClaudeConfigLockOptions = {},
): Promise<() => Promise<void>> {
  const previous = await withClaudeConfigLock(
    configPath,
    async () => {
      const config = await loadClaudeConfig(configPath);

      const projects = isRecord(config['projects']) ? config['projects'] : {};
      const entry = projects[root];

      if (TrustedEntrySchema.safeParse(entry).success) {
        return null;
      }

      const base = isRecord(entry) ? entry : {};

      // Write the values as read, not parsed output: zod drops a `__proto__` key
      // and reorders the keys the CLI wrote.
      await writeClaudeConfig(configPath, {
        ...config,
        projects: { ...projects, [root]: { ...base, hasTrustDialogAccepted: true } },
      });

      return { entry: isRecord(entry) ? entry : null };
    },
    lockOptions,
  );

  if (previous === null) {
    return () => Promise.resolve();
  }

  const written = JSON.stringify({
    ...previous.entry,
    hasTrustDialogAccepted: true,
  });

  return () =>
    withClaudeConfigLock(
      configPath,
      async () => {
        const config = await loadClaudeConfig(configPath);

        const projects = isRecord(config['projects']) ? config['projects'] : {};

        if (JSON.stringify(projects[root]) !== written) {
          return;
        }

        const { [root]: _trusted, ...others } = projects;

        await writeClaudeConfig(configPath, {
          ...config,
          projects: previous.entry === null ? others : { ...others, [root]: previous.entry },
        });
      },
      lockOptions,
    );
}

async function loadClaudeConfig(configPath: string): Promise<Record<string, unknown>> {
  let raw: string;

  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {};
    }

    throw error;
  }

  const parsed: unknown = JSON.parse(raw);

  if (!isRecord(parsed)) {
    throw new Error(`${configPath} does not hold a JSON object`);
  }

  return parsed;
}

async function writeClaudeConfig(
  configPath: string,
  config: Readonly<Record<string, unknown>>,
): Promise<void> {
  const target = await realpath(configPath).catch(() => configPath);

  const mode = await stat(target).then(
    (stats) => stats.mode & 0o777,
    () => 0o600,
  );

  const temp = join(dirname(target), `.atc-trust-${randomUUID()}.tmp`);

  try {
    await writeFile(temp, JSON.stringify(config, null, 2), { mode, flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });

    throw error;
  }
}
