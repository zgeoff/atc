import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isRecord } from '../shared/report';
import { withClaudeConfigLock } from './with-claude-config-lock';
import type { ClaudeConfigLockOptions } from './with-claude-config-lock';

/**
 * Accepts the Claude CLI's folder trust for one exact directory in its
 * global config, under the lock the CLI writes that config under. Only the
 * directory's entry in `projects` changes: every other key keeps its value,
 * and an entry already trusted leaves the file as it is. The write lands
 * through a rename, so a reader sees the old file or the new one, never
 * part of either.
 *
 * Resolves to a function that takes the trust back, for a launch that
 * fails before the CLI starts: it puts back the entry as it was, unless
 * something has changed the entry since, which leaves it as it stands.
 * The lock options apply to both the trust and its taking back.
 */
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

      if (isRecord(entry) && entry['hasTrustDialogAccepted'] === true) {
        return null;
      }

      const base = isRecord(entry) ? entry : {};

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

// The config as the CLI last wrote it; a missing file is an empty config,
// and one that does not parse to an object throws rather than be replaced.
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

// Writes the config in the CLI's own layout, beside the file it replaces
// and with that file's mode, then renames it into place. A config path
// that is a symlink keeps the link and replaces the file it points at.
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
