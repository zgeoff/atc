/**
 * The problem a config.json that sets both `agents` and old agent keys
 * reports: the keys, as "a", "a and b", or "a, b and c", and where they go.
 */
export function formatMixedAgentKeys(keys: readonly string[]): string {
  const last = keys.at(-1);
  const list = keys.length < 2 ? keys.join('') : `${keys.slice(0, -1).join(', ')} and ${last}`;

  return `${list} cannot be set together with agents; move them into agents or run 'atc config migrate'`;
}
