export function getTopLevelLine(lines: readonly string[], key: string): number {
  const keyPattern = new RegExp(`^['"]?${RegExp.escape(key)}['"]?:`, 'u');

  return lines.findIndex((line) => keyPattern.test(line)) + 1 || 1;
}
