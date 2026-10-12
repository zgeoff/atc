import { CODEX_TRUST_SEED_FILE } from './codex-trust-seed-file';

/**
 * The guest file that trusts the exact root of a verified clone in a Codex
 * session's own config: a `projects` table the launch appends to the
 * session's `config.toml`. A JSON string is a valid TOML basic string, so
 * the root is quoted as one.
 */
export function buildCodexTrustSeed(root: string): Readonly<Record<string, string>> {
  return {
    [CODEX_TRUST_SEED_FILE]: `\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`,
  };
}
