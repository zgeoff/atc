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

export function checkGitTransport(url: string, transports: readonly string[]): TransportCheck {
  // git would read a leading dash as an option, whatever the transports
  if (url.startsWith('-')) {
    return { ok: false, code: 'invalid_git_url', message: 'a git URL must not start with -' };
  }

  const transport = findTransport(url);

  if (transports.includes(transport)) {
    return { ok: true };
  }

  const allowed =
    transports.length === 0
      ? 'workspaces.gitTransports allows no transports'
      : `the daemon fetches over ${transports.join(' and ')}`;

  return {
    ok: false,
    code: 'invalid_git_url',
    message: `git transport '${transport}' is not allowed; ${allowed}`,
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
