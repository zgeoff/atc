// $1: the sign-in volume's mount. Succeeds when the image's user can read a token file there that
// holds something.
export const PROBE_SIGN_IN_SCRIPT =
  'test -r "$1/claude-oauth-token" && test -s "$1/claude-oauth-token"';
