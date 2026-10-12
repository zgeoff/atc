// A URL with a scheme, an scp-style `user@host:path`, or an absolute path.
const GIT_URL_PATTERN = /^(?:[a-z][a-z\d+.-]*:\/\/|[^@/:\s]+@[^@/:\s]+:|\/)/iu;

/**
 * Whether typed text is a git repository URL in a form git itself reads:
 * one with a scheme, the scp-style `user@host:path`, or an absolute path
 * to a repository on the daemon's host.
 */
export function isGitURL(input: string): boolean {
  return GIT_URL_PATTERN.test(input.trim());
}
