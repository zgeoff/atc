/**
 * The script of a stand-in `gh` that is signed out: every command prints
 * gh's own sign-in hint to stderr and exits 4, as the real one does before
 * `gh auth login`. The hint is gh 2.99.0's text, byte for byte.
 */
export function buildStubSignedOutGH(): string {
  return "#!/bin/sh\nprintf '%s\\n%s\\n' 'To get started with GitHub CLI, please run:  gh auth login' 'Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.' >&2\nexit 4\n";
}
