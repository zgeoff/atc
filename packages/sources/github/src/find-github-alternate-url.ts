const HTTPS_PATTERN = /^https:\/\/github\.com\/(?<owner>[\w.-]+)\/(?<repo>[\w.-]+?)(?:\.git)?\/?$/u;

const SSH_PATTERN =
  /^(?:ssh:\/\/)?git@github\.com[:/](?<owner>[\w.-]+)\/(?<repo>[\w.-]+?)(?:\.git)?$/u;

export function findGitHubAlternateURL(url: string): string | null {
  const ssh = SSH_PATTERN.exec(url)?.groups;

  if (ssh !== undefined) {
    return `https://github.com/${ssh['owner']}/${ssh['repo']}.git`;
  }

  const https = HTTPS_PATTERN.exec(url)?.groups;

  return https === undefined ? null : `git@github.com:${https['owner']}/${https['repo']}.git`;
}
