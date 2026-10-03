/**
 * Whether a variable is one impd sets in a brokered exec to route requests
 * through the broker and trust its CA. impd lets a variable the caller
 * sets win, so a caller's own value would route around the broker or mask
 * a failed CA install. Some clients read proxy and CA variables in either
 * case, so the check ignores case.
 */
export function isBrokerVariable(key: string): boolean {
  return BROKER_VARIABLES.has(key.toUpperCase());
}

const BROKER_VARIABLES: ReadonlySet<string> = new Set([
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
]);
