// The transports atc fetches over unless the daemon's environment widens
// them.
const DEFAULT_PROTOCOLS = ['https', 'ssh'];

// Transports that run a command or read a descriptor on the daemon's host,
// which no setting allows.
const NEVER_ALLOWED: ReadonlySet<string> = new Set(['ext', 'fd']);

/**
 * The git transports atc lets a repository URL use: `https` and `ssh`,
 * unless the daemon's environment sets `ATC_GIT_ALLOW_PROTOCOL` to a
 * colon-separated list in git's own `GIT_ALLOW_PROTOCOL` form. `ext` and
 * `fd` are left out of any list.
 */
export function resolveGitProtocols(): readonly string[] {
  const configured = process.env['ATC_GIT_ALLOW_PROTOCOL'];

  const protocols =
    configured === undefined || configured === '' ? DEFAULT_PROTOCOLS : configured.split(':');

  return protocols.filter((protocol) => protocol !== '' && !NEVER_ALLOWED.has(protocol));
}
