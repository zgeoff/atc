/**
 * The problem a config.json that sets old agent keys and no `agents`
 * reports: the keys, and the command that moves them into `agents`.
 */
export function formatLegacyAgentKeys(keys: readonly string[]): string {
  return `config.json uses the old agent keys (${keys.join(', ')}); run 'atc config migrate' to move them into agents`;
}
