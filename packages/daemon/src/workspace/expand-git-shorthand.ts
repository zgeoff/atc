const SHORTHAND_PATTERN = /^(?<name>[\w-][\w.-]*\/[\w.-]+?)(?:\.git)?$/u;

export function expandGitShorthand(raw: string): string {
  const name = SHORTHAND_PATTERN.exec(raw.trim())?.groups?.['name'];

  return name === undefined ? raw : `https://github.com/${name}.git`;
}
