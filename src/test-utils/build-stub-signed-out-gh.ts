/**
 * The script of a stand-in `gh` that is signed out: every command prints
 * gh's own sign-in hint to stderr and exits 4, as the real one does before
 * `gh auth login`.
 */
export function buildStubSignedOutGH(): string {
  return "#!/bin/sh\necho 'gh auth login' >&2\nexit 4\n";
}
