/**
 * Where the Claude config bundle of a session travels inside its guest
 * folder: beside the config folder rather than in it, so the launch replaces
 * the bundle's own entries in the config folder whole, and an entry the
 * host no longer holds leaves the config folder with it.
 */
export const CLAUDE_CONFIG_BUNDLE_FOLDER = 'claude-config-bundle';
