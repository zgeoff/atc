// Standard Webhooks symmetric secrets are `whsec_` followed by base64, and the Events extension
// requires the decoded key to be 24 to 64 bytes.
export function parseWebhookSecret(secret: string): Uint8Array | null {
  const match = /^whsec_(?<encoded>[A-Za-z0-9+/]+={0,2})$/u.exec(secret);
  const encoded = match?.groups?.['encoded'];

  if (encoded === undefined || encoded.length % 4 !== 0) {
    return null;
  }

  const bytes = Buffer.from(encoded, 'base64');

  return bytes.length >= 24 && bytes.length <= 64 ? bytes : null;
}
