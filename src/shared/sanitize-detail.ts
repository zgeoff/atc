/**
 * Replaces credential-shaped text with `[redacted]`, whatever its length:
 * URL userinfo, whole authorization header values, values of secret-named
 * parameters and headers — quoted values included, whole — and long
 * token-like runs. Ordinary words pass through.
 */
export function sanitizeDetail(text: string): string {
  return text
    .replaceAll(/(?<scheme>[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$<scheme>[redacted]@')
    .replaceAll(
      /(?<name>["']?authorization["']?\s*:\s*)(?:"(?:[^"\\]|\\.)*"|[^\n]*)/giu,
      '$<name>[redacted]',
    )
    .replaceAll(
      /(?<name>["']?[a-z0-9_.-]*(?:key|token|secret|password|passwd|credential|signature)[a-z0-9_.-]*["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s;,;&"']+)/giu,
      '$<name>[redacted]',
    )
    .replaceAll(/\b(?<scheme>bearer|basic)\s+[a-z0-9+/=._-]+/giu, '$<scheme> [redacted]')
    .replaceAll(/[a-z0-9+/_=-]{32,}/giu, '[redacted]');
}
