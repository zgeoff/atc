// The error codes better-auth sends to the error page, each with the fixed
// sentence atc shows for it.
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_client: 'the client is not one added to atc.',
  client_disabled: 'the client is disabled.',
  invalid_redirect: 'the redirect URI is not one the client was added with.',
  unauthorized_client: 'the client may not use the authorization code grant.',
  unsupported_response_type: 'atc supports only the authorization code response type.',
  invalid_request: 'the request is malformed.',
};

/**
 * The sentence the error page shows for an error code, or a generic one for
 * a code atc does not know. The page never shows text from the request, so a
 * link to it cannot make atc's origin display words an attacker chose.
 */
export function pickErrorMessage(code: string | null): string {
  const reason =
    code !== null && Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : undefined;

  return `atc refused this authorization request: ${reason ?? 'the request is not valid.'}`;
}
