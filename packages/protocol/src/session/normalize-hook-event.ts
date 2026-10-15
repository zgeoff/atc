/**
 * Canonicalize a hook event name to PascalCase. Claude already sends
 * PascalCase (`SessionStart`); Grok sends snake_case (`session_start`).
 * Restore stagger and the adapter switch compare the PascalCase form.
 */
export function normalizeHookEventName(raw: string): string {
  return raw
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}
