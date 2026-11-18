// Gh 2.99.0's sign-in hint, byte for byte.
export function buildStubSignedOutGH(): string {
  return "#!/bin/sh\nprintf '%s\\n%s\\n' 'To get started with GitHub CLI, please run:  gh auth login' 'Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.' >&2\nexit 4\n";
}
