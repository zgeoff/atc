/**
 * The config.json keys of the old agent shape, which `agents` replaces: the
 * harness binaries and arguments, the Claude subscription auth, and the
 * gateway map.
 */
export const LEGACY_AGENT_KEYS: readonly string[] = [
  'claudeBin',
  'claudeArgs',
  'claudeAuth',
  'grokBin',
  'grokArgs',
  'codexBin',
  'codexArgs',
  'gateways',
];
