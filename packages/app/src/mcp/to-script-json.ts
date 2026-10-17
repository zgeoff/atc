export function toScriptJSON(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', String.raw`\u003c`)
    .replaceAll('>', String.raw`\u003e`)
    .replaceAll('&', String.raw`\u0026`);
}
