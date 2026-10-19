import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { collectCredentialConfigKeys } from './collect-credential-config-keys';
import { normalizeGitURL } from './normalize-git-url';
import { runGit } from './run-git';
import type { WorkspaceProvenance } from './workspace-provenance';

interface SanitizedClone {
  readonly ok: true;
  readonly provenance: WorkspaceProvenance;
}

interface SanitizeRefusal {
  readonly ok: false;
  readonly code: 'invalid_git_url' | 'sanitize_failed';
  readonly message: string;
}

// strips everything that could authenticate as, or run code for, the host the clone was made
// on, before the clone leaves that host
export async function sanitizeWorkspaceClone(
  dir: string,
  url: string,
): Promise<SanitizeRefusal | SanitizedClone> {
  const normalized = normalizeGitURL(url);

  if (!normalized.ok) {
    return normalized;
  }

  const gitDir = join(dir, '.git');
  const configFile = join(gitDir, 'config');

  for (const key of await readCredentialKeys(configFile)) {
    await runGit(['config', '--file', configFile, '--unset-all', key]);
  }

  const setURL = await runGit([
    'config',
    '--file',
    configFile,
    'remote.origin.url',
    normalized.url,
  ]);

  if (setURL.exitCode !== 0) {
    return { ok: false, code: 'sanitize_failed', message: setURL.stderr.trim() };
  }

  await rm(join(gitDir, 'hooks'), { recursive: true, force: true });
  await mkdir(join(gitDir, 'hooks'));

  // reflogs record the clone URL
  await rm(join(gitDir, 'logs'), { recursive: true, force: true });

  for (const file of ['.git-credentials', '.netrc']) {
    await rm(join(dir, file), { force: true });
    await rm(join(gitDir, file), { force: true });
  }

  return verifyClone(dir, configFile, normalized.url);
}

// Every credential key the repository config holds.
async function readCredentialKeys(configFile: string): Promise<string[]> {
  const listed = await runGit(['config', '--file', configFile, '--list', '-z']);

  return collectCredentialConfigKeys(listed.stdout);
}

async function verifyClone(
  dir: string,
  configFile: string,
  url: string,
): Promise<SanitizeRefusal | SanitizedClone> {
  const log = await runGit(['log', '-1', '--format=%H'], { cwd: dir });

  if (log.exitCode !== 0) {
    return {
      ok: false,
      code: 'sanitize_failed',
      message: `history unreadable: ${log.stderr.trim()}`,
    };
  }

  const remaining = await readCredentialKeys(configFile);

  if (remaining.length > 0) {
    return {
      ok: false,
      code: 'sanitize_failed',
      message: `config still holds ${remaining.length} credential entries`,
    };
  }

  return { ok: true, provenance: { repoURL: url, sha: log.stdout.trim() } };
}
