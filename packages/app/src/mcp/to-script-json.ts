/**
 * Serializes a value as JSON that is safe inside an HTML `<script>` data
 * block: every `<`, `>`, and `&` becomes its JSON escape, so the text can
 * neither close the block nor open a comment, and it still parses to the
 * same value.
 */
export function toScriptJSON(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', String.raw`\u003c`)
    .replaceAll('>', String.raw`\u003e`)
    .replaceAll('&', String.raw`\u0026`);
}
