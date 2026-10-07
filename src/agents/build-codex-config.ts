/**
 * The `config.toml` of a Codex session on a remote host: credentials stay
 * in the `auth.json` atc writes, never in a keyring, and the TUI checks
 * for no update, since the host's image fixes the version it runs.
 */
export function buildCodexConfig(): string {
  return ['cli_auth_credentials_store = "file"', 'check_for_update_on_startup = false', ''].join(
    '\n',
  );
}
