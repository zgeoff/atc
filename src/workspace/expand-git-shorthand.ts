// A bare `owner/repo`, with or without `.git`.
const SHORTHAND_PATTERN = /^(?<name>[\w-][\w.-]*\/[\w.-]+?)(?:\.git)?$/u;

/**
 * Expands the `owner/repo` shorthand a `session.spawn` git workspace may
 * hold to its GitHub https URL, and returns any other URL as it is. The
 * shorthand is the spawn API's alone: every other path takes full URLs.
 */
export function expandGitShorthand(raw: string): string {
  const name = SHORTHAND_PATTERN.exec(raw.trim())?.groups?.['name'];

  return name === undefined ? raw : `https://github.com/${name}.git`;
}
