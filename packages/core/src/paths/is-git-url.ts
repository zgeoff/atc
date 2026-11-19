const GIT_URL_PATTERN = /^(?:[a-z][a-z\d+.-]*:\/\/|[^@/:\s]+@[^@/:\s]+:|\/)/iu;

export function isGitURL(input: string): boolean {
  return GIT_URL_PATTERN.test(input.trim());
}
