/**
 * Flattens text to one line and caps it at 200 characters, ellipsizing
 * anything longer, for a session's one-line status.
 */
export function truncateSummary(text: string): string {
  const flat = text.replaceAll('\n', ' ');

  return flat.length <= 200 ? flat : `${flat.slice(0, 199)}…`;
}
