import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
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

/**
 * Strips a fresh clone of everything that could authenticate as, or run code
 * for, the host it was cloned on, before the clone leaves that host. Objects,
 * refs, HEAD, and the checked-out branch stay. The origin URL is reset to its
 * token-free form; every credential setting, every http extra header, every
 * remote URL carrying a credential, and every URL rewrite whose either side holds
 * userinfo are removed from the repository config; hooks, reflogs (which
 * record the clone URL), and any `.git-credentials` or `.netrc` file are
 * deleted. The result is then checked: the history still reads and the
 * config holds no credential.
 */
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

  for (const key of await collectCredentialKeys(configFile)) {
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
  await rm(join(gitDir, 'logs'), { recursive: true, force: true });

  for (const file of ['.git-credentials', '.netrc']) {
    await rm(join(dir, file), { force: true });
    await rm(join(gitDir, file), { force: true });
  }

  return verifyClone(dir, configFile, normalized.url);
}

/**
 * Every config key whose setting can carry a secret: credential helpers and
 * usernames, http extra headers (where an Authorization header rides),
 * remote URLs that lose something when stripped of credentials, and URL
 * rewrites whose either side holds userinfo.
 */
async function collectCredentialKeys(configFile: string): Promise<string[]> {
  const listed = await runGit(['config', '--file', configFile, '--list', '-z']);

  const keys = new Set<string>();

  for (const entry of listed.stdout.split('\0')) {
    const newline = entry.indexOf('\n');
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? '' : entry.slice(newline + 1);

    if (isCredentialEntry(key.toLowerCase(), key, value)) {
      keys.add(key);
    }
  }

  return [...keys];
}

const URL_WITH_USERINFO = /^[a-z][a-z\d+.-]*:\/\/[^/]*@/iu;

function isCredentialEntry(lowered: string, key: string, value: string): boolean {
  if (lowered.startsWith('credential.')) {
    return true;
  }

  if (lowered.startsWith('http.') && lowered.endsWith('.extraheader')) {
    return true;
  }

  if (lowered.startsWith('remote.') && /\.(?:url|pushurl)$/u.test(lowered)) {
    const normalized = normalizeGitURL(value);

    return !normalized.ok || normalized.url !== value;
  }

  const rewrite = /^url\.(?<base>.+)\.(?:insteadof|pushinsteadof)$/iu.exec(key);

  if (rewrite !== null) {
    return URL_WITH_USERINFO.test(rewrite.groups?.['base'] ?? '') || URL_WITH_USERINFO.test(value);
  }

  return false;
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

  const remaining = await collectCredentialKeys(configFile);

  if (remaining.length > 0) {
    return {
      ok: false,
      code: 'sanitize_failed',
      message: `config still holds ${remaining.length} credential entries`,
    };
  }

  return { ok: true, provenance: { repoURL: url, sha: log.stdout.trim() } };
}
