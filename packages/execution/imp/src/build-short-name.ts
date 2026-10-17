export function buildShortName(value: string, length: number): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, '')
    .slice(0, length);
}
