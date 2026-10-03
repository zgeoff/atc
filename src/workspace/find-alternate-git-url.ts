const HTTPS_PATTERN = /^https:\/\/github\.com\/(?<owner>[\w.-]+)\/(?<repo>[\w.-]+?)(?:\.git)?\/?$/u;

const SSH_PATTERN =
  /^(?:ssh:\/\/)?git@github\.com[:/](?<owner>[\w.-]+)\/(?<repo>[\w.-]+?)(?:\.git)?$/u;

const SHORTHAND_PATTERN = /^(?<owner>[A-Za-z\d][\w.-]*)\/(?<repo>[\w.-]+?)(?:\.git)?$/u;

/**
 * The other URL form of a GitHub repository: the ssh form of an https URL
 * or an `owner/repo`, which the daemon fetches over https, and the https
 * form of an ssh URL. Null for a repository not on GitHub.
 */
export function findAlternateGitURL(url: string): string | null {
  const ssh = SSH_PATTERN.exec(url)?.groups;

  if (ssh !== undefined) {
    return `https://github.com/${ssh['owner']}/${ssh['repo']}.git`;
  }

  const https = (HTTPS_PATTERN.exec(url) ?? SHORTHAND_PATTERN.exec(url))?.groups;

  return https === undefined ? null : `git@github.com:${https['owner']}/${https['repo']}.git`;
}
