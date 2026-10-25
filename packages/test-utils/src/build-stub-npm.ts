// npm 11.19.0 answers `npm view <name>@<version> version` for a version the
// registry lacks with this E404 and exit code 1, not with empty output.
export function buildStubNpm(record: string, heldVersion: string | null): string {
  const view =
    heldVersion === null
      ? `  printf 'npm error code E404\\nnpm error 404 No match found for version %s\\n' "\${2##*@}" >&2\n  exit 1\n`
      : `  echo '${heldVersion}'\n  exit 0\n`;

  return `#!/bin/sh\necho "$@" >> '${record}'\nif [ "$1" = view ]; then\n${view}fi\n`;
}
