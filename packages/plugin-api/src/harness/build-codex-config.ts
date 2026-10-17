// credentials stay in the auth.json atc writes, never a keyring, and the TUI
// skips its update check, since the host's image fixes the version it runs.
export function buildCodexConfig(): string {
  return ['cli_auth_credentials_store = "file"', 'check_for_update_on_startup = false', ''].join(
    '\n',
  );
}
