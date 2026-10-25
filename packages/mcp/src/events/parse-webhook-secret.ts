// A Standard Webhooks symmetric secret: `whsec_` and the base64 of 24 to 64
// bytes, the range the Events extension requires. Anything else parses to null.
export function parseWebhookSecret(secret: string): Uint8Array | null {
  const match = /^whsec_(?<encoded>[A-Za-z0-9+/]+={0,2})$/u.exec(secret);
  const encoded = match?.groups?.['encoded'];

  if (encoded === undefined || encoded.length % 4 !== 0) {
    return null;
  }

  const bytes = Buffer.from(encoded, 'base64');

  return bytes.length >= 24 && bytes.length <= 64 ? bytes : null;
}
