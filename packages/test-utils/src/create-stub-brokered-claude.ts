import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';

// The variables that route a request through a broker's proxy and trust its
// certificate authority.
const PROXY_VARIABLES = [
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'CURL_CA_BUNDLE',
  'SSL_CERT_FILE',
] as const;

// A stand-in claude that sends the auth token its `--settings` file holds as
// a bearer token to the URL, with the proxy variables of the process that
// creates it, and writes the HTTP status to `brokered-status` in the dir.
export function createStubBrokeredClaude(dir: string, url: string): string {
  // the guest's PATH may lack the tools the test process finds
  const curl = Bun.which('curl') ?? 'curl';
  const sed = Bun.which('sed') ?? 'sed';
  const status = join(dir, 'brokered-status');

  const exports = PROXY_VARIABLES.flatMap((name) => {
    const value = process.env[name];

    return value === undefined ? [] : [`export ${name}=${formatShellWord(value)}`];
  });

  return createStubBin(
    dir,
    'fake-claude',
    [
      '#!/bin/sh',
      ...exports,
      "settings=''",
      'while [ $# -gt 0 ]; do',
      '  if [ "$1" = --settings ]; then settings="$2"; fi',
      '  shift',
      'done',
      `token=$(${formatShellWord(sed)} -n 's/.*"ANTHROPIC_AUTH_TOKEN": *"\\([^"]*\\)".*/\\1/p' "$settings")`,
      `${formatShellWord(curl)} -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $token" ${formatShellWord(url)} > ${formatShellWord(`${status}.part`)}`,
      `mv ${formatShellWord(`${status}.part`)} ${formatShellWord(status)}`,
      'exec sleep 30',
      '',
    ].join('\n'),
  );
}

function formatShellWord(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
