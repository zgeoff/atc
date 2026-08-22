/**
 * Wraps a value in single quotes so it stands as one shell argument,
 * escaping any single quotes the value itself contains.
 */
export function toShellArg(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
