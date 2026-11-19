const SHORTHAND_PATTERN = /^(?<name>[\w-][\w.-]*\/[\w.-]+?)(?:\.git)?$/u;

// Only the spawn API accepts the shorthand. Every other path takes a full URL, so a local
// path like `dir/repo` is never read as a GitHub repository.
export function expandGitShorthand(raw: string): string {
  const name = SHORTHAND_PATTERN.exec(raw.trim())?.groups?.['name'];

  return name === undefined ? raw : `https://github.com/${name}.git`;
}
