import { resolveGitProtocols } from './resolve-git-protocols';

type TransportCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'invalid_git_url'; readonly message: string };

// `<transport>::<address>`, which runs git's remote helper for the
// transport, such as `ext::` or `fd::`.
const HELPER_PATTERN = /^(?<name>[A-Za-z][\w+.-]*)::/u;

// `<scheme>://…`.
const SCHEME_PATTERN = /^(?<name>[A-Za-z][\w+.-]*):\/\//u;

// The scp-style `user@host:path` or `host:path`, which git reads as ssh.
const SCP_PATTERN = /^(?:[^@/:\s]+@)?[^@/:\s]+:/u;

// Schemes git treats as ssh.
const SSH_SCHEMES: ReadonlySet<string> = new Set(['ssh', 'git+ssh', 'ssh+git']);

/**
 * Checks that a repository URL uses a git transport atc allows, without
 * running git: `https` and `ssh` by default, the scp-style form counting as
 * ssh. A remote-helper URL is its helper's transport, and a path is the
 * `file` transport. A URL that git could read as an option is refused.
 */
export function checkGitTransport(url: string): TransportCheck {
  if (url.startsWith('-')) {
    return { ok: false, code: 'invalid_git_url', message: 'a git URL must not start with -' };
  }

  const transport = findTransport(url);
  const allowed = resolveGitProtocols();

  if (allowed.includes(transport)) {
    return { ok: true };
  }

  return {
    ok: false,
    code: 'invalid_git_url',
    message: `git transport '${transport}' is not allowed; atc fetches over ${allowed.join(' and ')}`,
  };
}

function findTransport(url: string): string {
  const helper = HELPER_PATTERN.exec(url)?.groups?.['name'];

  if (helper !== undefined) {
    return helper.toLowerCase();
  }

  const scheme = SCHEME_PATTERN.exec(url)?.groups?.['name']?.toLowerCase();

  if (scheme !== undefined) {
    return SSH_SCHEMES.has(scheme) ? 'ssh' : scheme;
  }

  return SCP_PATTERN.test(url) ? 'ssh' : 'file';
}
