export function formatMixedAgentKeys(keys: readonly string[]): string {
  const last = keys.at(-1);
  const list = keys.length < 2 ? keys.join('') : `${keys.slice(0, -1).join(', ')} and ${last}`;

  return `${list} cannot be set together with agents; move them into agents or run 'atc config migrate'`;
}
