/**
 * Caps a detail string at 600 characters, ellipsizing anything longer so a
 * single hook payload cannot blow up the briefing text.
 */
export function truncateDetail(text: string): string {
  return text.length <= 600 ? text : `${text.slice(0, 599)}…`;
}
