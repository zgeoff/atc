// The deprecation line of a file that still sets the old source keys.
export function formatLegacySourceKeys(keys: readonly string[]): string {
  const list =
    keys.length < 2 ? keys.join('') : `${keys.slice(0, -1).join(', ')} and ${keys.at(-1)}`;

  const pronoun = keys.length < 2 ? 'it' : 'them';

  return `config.json uses ${list}; run 'atc config migrate' to move ${pronoun} into sources`;
}
