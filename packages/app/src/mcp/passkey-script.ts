import { createHash } from 'node:crypto';

// Runs the ceremony a page's `atc-passkey` JSON block holds, `create` to
// enroll a passkey or `get` to sign in with one, puts the credential's JSON
// in the form's `credential` field, and posts the form. A prompt that ends
// without a credential leaves the form unsent and the button ready again.
const SOURCE = `(() => {
  const data = document.getElementById('atc-passkey');
  const form = document.getElementById('atc-passkey-form');
  const button = document.getElementById('atc-passkey-start');
  const status = document.getElementById('atc-passkey-status');
  if (data === null || form === null || button === null || status === null) return;
  const spec = JSON.parse(data.textContent);
  const toBytes = (value) => {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  };
  const toText = (buffer) => {
    let text = '';
    for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte);
    return btoa(text).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  };
  const toDescriptors = (list) => (list || []).map((item) => ({ ...item, id: toBytes(item.id) }));
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = '';
    try {
      const options = spec.options;
      const credential = spec.mode === 'create'
        ? await navigator.credentials.create({ publicKey: { ...options, challenge: toBytes(options.challenge), user: { ...options.user, id: toBytes(options.user.id) }, excludeCredentials: toDescriptors(options.excludeCredentials) } })
        : await navigator.credentials.get({ publicKey: { ...options, challenge: toBytes(options.challenge), allowCredentials: toDescriptors(options.allowCredentials) } });
      const reply = credential.response;
      const response = spec.mode === 'create'
        ? { clientDataJSON: toText(reply.clientDataJSON), attestationObject: toText(reply.attestationObject), transports: typeof reply.getTransports === 'function' ? reply.getTransports() : [] }
        : { clientDataJSON: toText(reply.clientDataJSON), authenticatorData: toText(reply.authenticatorData), signature: toText(reply.signature), userHandle: reply.userHandle ? toText(reply.userHandle) : undefined };
      form.elements.namedItem('credential').value = JSON.stringify({ id: credential.id, rawId: toText(credential.rawId), type: credential.type, response, clientExtensionResults: credential.getClientExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment || undefined });
      form.submit();
    } catch (error) {
      status.textContent = 'The passkey prompt ended without a passkey (' + (error && error.name ? error.name : 'Error') + '). Try again.';
      button.disabled = false;
    }
  });
})();`;

/**
 * The one script atc's sign-in and enrollment pages run, and the
 * Content-Security-Policy source that allows it and no other script.
 */
export const PASSKEY_SCRIPT = {
  source: SOURCE,
  policySource: `'sha256-${createHash('sha256').update(SOURCE).digest('base64')}'`,
} as const;
