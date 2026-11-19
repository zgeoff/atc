export function formatLegacyAgentKeys(keys: readonly string[]): string {
  return `config.json uses the old agent keys (${keys.join(', ')}); run 'atc config migrate' to move them into agents`;
}
