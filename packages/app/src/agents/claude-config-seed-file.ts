/**
 * Where the seed of a session's own Claude config folder travels inside its
 * guest folder: beside the config folder rather than in it, so a transfer
 * never replaces the state an earlier run of the CLI left there.
 */
export const CLAUDE_CONFIG_SEED_FILE = 'claude-config-seed.json';
