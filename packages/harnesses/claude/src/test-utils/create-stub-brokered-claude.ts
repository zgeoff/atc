import { join } from 'node:path';
import { createStubBin } from '@atc/core/test-utils/create-stub-bin';

const PROXY_VARIABLES = [
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'CURL_CA_BUNDLE',
  'SSL_CERT_FILE',
] as const;

export function createStubBrokeredClaude(directory: string, url: string): string {
  // The guest's PATH may lack curl and sed, so resolve their paths in the test process.
  const curl = Bun.which('curl') ?? 'curl';
  const sed = Bun.which('sed') ?? 'sed';
  const status = join(directory, 'brokered-status');

  const exports = PROXY_VARIABLES.flatMap((name) => {
    const value = process.env[name];

    return value === undefined ? [] : [`export ${name}=${formatShellWord(value)}`];
  });

  return createStubBin(
    directory,
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
