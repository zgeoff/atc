import { loadWebAuthn } from '../auth/load-web-authn';

// The first passkey ceremony in a test process loads the WebAuthn library,
// measured at about 0.26 s cold against 0.015 s warm. Loading it here keeps
// that one-time cost out of the first test's timeout.
await loadWebAuthn();
