export interface TruncateOptions {
  // each newline becomes a space before the cut, so the result fits on one
  // line
  readonly flatten?: boolean;
}

/**
 * Caps text at `max` characters, ending anything longer with an ellipsis
 * that counts toward the cap.
 */
export function truncate(text: string, max: number, options?: TruncateOptions): string {
  const flat = options?.flatten === true ? text.replaceAll('\n', ' ') : text;

  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
