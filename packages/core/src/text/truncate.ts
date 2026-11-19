export interface TruncateOptions {
  readonly flatten?: boolean;
}

export function truncate(text: string, max: number, options?: TruncateOptions): string {
  const flat = options?.flatten === true ? text.replaceAll('\n', ' ') : text;

  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
