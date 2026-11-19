export function truncate(text: string, max: number): string {
  // oxlint-disable-next-line no-control-regex -- stripping ANSI/newline control bytes is the point
  const clean = text.replaceAll(/[\r\n\u001B]+/gu, ' ');

  if (max <= 0) {
    return '';
  }

  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}
