import { CODEX_TRUST_SEED_FILE } from './codex-trust-seed-file';

export function buildCodexTrustSeed(root: string): Readonly<Record<string, string>> {
  return {
    // a JSON string is a valid TOML basic string, so it quotes the root
    [CODEX_TRUST_SEED_FILE]: `\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`,
  };
}
