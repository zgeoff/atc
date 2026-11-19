const SHORTHAND_PATTERN = /^(?<name>[\w-][\w.-]*\/[\w.-]+?)(?:\.git)?$/u;

// A local path like `dir/repo` matches the shorthand pattern and would be read as a GitHub
// repository. Only the spawn API may expand shorthand; every other path takes a full URL.
export function expandGitShorthand(raw: string): string {
  const name = SHORTHAND_PATTERN.exec(raw.trim())?.groups?.['name'];

  return name === undefined ? raw : `https://github.com/${name}.git`;
}
