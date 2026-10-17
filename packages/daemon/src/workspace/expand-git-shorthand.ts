// A bare `owner/repo`, with or without `.git`.
const SHORTHAND_PATTERN = /^(?<name>[\w-][\w.-]*\/[\w.-]+?)(?:\.git)?$/u;

// the shorthand is the spawn API's alone: every other path takes full URLs
export function expandGitShorthand(raw: string): string {
  const name = SHORTHAND_PATTERN.exec(raw.trim())?.groups?.['name'];

  return name === undefined ? raw : `https://github.com/${name}.git`;
}
