import { DaemonError } from '@atc/protocol/wire';
import type { SpawnWorkspaceSource } from '@atcx/contract';
import { checkURLCredentials } from './check-url-credentials';
import { expandGitShorthand } from './expand-git-shorthand';
import { normalizeGitURL } from './normalize-git-url';
import { readCredentialSecret } from './read-credential-secret';
import { requireStartFailure } from './require-start-failure';
import { resolveGitURL } from './resolve-git-url';
import { resolvePathSource } from './resolve-path-source';
import { runGit } from './run-git';

export interface PinnedSource {
  readonly cloneURL: string;
  readonly repoURL: string;

  readonly checkout: string;
  readonly sha?: string | undefined;
  readonly ref: string | null;
  readonly credential: { readonly kind: 'env'; readonly name: string } | undefined;
  readonly warnings: readonly string[];
}

export async function resolveSource(
  source: SpawnWorkspaceSource,
  staging: string,
  transports: readonly string[],
): Promise<PinnedSource> {
  if (source.kind === 'path') {
    // The origin is checked as configured, before resolving it applies any
    // rewrite: a rewrite the checkout's own config holds expands it too.
    await requireNoOriginRewriteCredentials(source.path);

    const resolved = await resolvePathSource(source.path, {
      ...(source.allowDirty === undefined ? {} : { allowDirty: source.allowDirty }),
      transports,
    });

    if (!resolved.ok) {
      throw new DaemonError(resolved.code, resolved.message, { phase: 'resolving' });
    }

    await requireNoURLCredentials(resolved.url, staging);

    return {
      cloneURL: resolved.url,
      repoURL: resolved.url,
      checkout: resolved.sha,
      ref: resolved.branch,
      credential: undefined,
      warnings: resolved.warnings,
    };
  }

  if (source.credentialRef !== undefined && readCredentialSecret(source) === null) {
    throw new DaemonError(
      'credential_missing',
      'the credential environment variable is unset or empty',
      { phase: 'resolving' },
    );
  }

  const resolved = await resolveGitURL(expandGitShorthand(source.url), staging, transports);

  if (!resolved.ok) {
    throw new DaemonError(resolved.code, resolved.message, { phase: 'resolving' });
  }

  return {
    cloneURL: resolved.url,
    repoURL: resolved.url,
    checkout: source.ref ?? source.sha ?? '',
    sha: source.ref === undefined ? undefined : source.sha,
    ref: source.ref ?? null,
    credential: source.credentialRef,
    warnings: [],
  };
}

async function requireNoOriginRewriteCredentials(path: string): Promise<void> {
  const origin = await runGit(['config', '--get', 'remote.origin.url'], { cwd: path }).catch(
    requireStartFailure,
  );

  const normalized = origin?.exitCode === 0 ? normalizeGitURL(origin.stdout) : null;

  if (normalized?.ok === true) {
    await requireNoURLCredentials(normalized.url, path);
  }
}

async function requireNoURLCredentials(url: string, cwd: string): Promise<void> {
  const finding = await checkURLCredentials(url, cwd);

  if (!finding.ok) {
    throw new DaemonError(finding.code, finding.message, { phase: 'resolving' });
  }
}
