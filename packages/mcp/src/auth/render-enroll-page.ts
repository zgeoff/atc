import { PASSKEY_SCRIPT } from './passkey-script';
import { toHTMLText } from './to-html-text';
import { toScriptJSON } from './to-script-json';

interface EnrollPageView {
  // The enrollment token the owner typed, once it checked out, with the
  // WebAuthn creation options for its challenge; null asks for the token.
  readonly ceremony: { readonly token: string; readonly options: unknown } | null;
  readonly error: string | null;
}

export function renderEnrollPage(view: EnrollPageView): string {
  const error = view.error === null ? '' : `<p class="error">${toHTMLText(view.error)}</p>`;

  const step =
    view.ceremony === null
      ? `<p>Type the enrollment token that <code>atc passkeys enroll</code> or <code>atc-gateway passkeys enroll</code> printed on the host.</p>
<form method="post" action="/enroll">
<label>Enrollment token <input name="token" autocomplete="off" autofocus required></label>
<button type="submit">Continue</button>
</form>`
      : `<p>Create a passkey for atc. Your device asks you to verify yourself.</p>
<script type="application/json" id="atc-passkey">${toScriptJSON({ mode: 'create', options: view.ceremony.options })}</script>
<form method="post" action="/enroll" id="atc-passkey-form">
<input type="hidden" name="token" value="${toHTMLText(view.ceremony.token)}">
<input type="hidden" name="credential" value="">
<button type="button" id="atc-passkey-start" autofocus>Create a passkey</button>
</form>
<p id="atc-passkey-status" class="error" role="status"></p>
<script>${PASSKEY_SCRIPT.source}</script>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Enroll a passkey for atc</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
input[name="token"] { font: inherit; font-family: ui-monospace, monospace; padding: 0.25rem; width: 100%; }
.error { color: #b00020; }
code { word-break: break-all; }
button { font: inherit; }
</style>
</head>
<body>
<h1>Enroll a passkey for atc</h1>
${error}
${step}
</body>
</html>
`;
}
