import { toHTMLText } from './to-html-text';

interface LoginPageView {
  // The signed authorization query the page posts back.
  readonly oauthQuery: string;
  readonly clientName: string;
  readonly redirectURI: string;
  readonly error: string | null;
}

/**
 * The page where the operator proves they run atc: the client's name, the
 * full redirect URI, and a field for the approval code atc printed in its
 * terminal. Every dynamic value is escaped.
 */
export function renderLoginPage(view: LoginPageView): string {
  const error = view.error === null ? '' : `<p class="error">${toHTMLText(view.error)}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve access to atc</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
input[name="code"] { font: inherit; font-family: ui-monospace, monospace; letter-spacing: 0.1em; padding: 0.25rem; }
.error { color: #b00020; }
code { word-break: break-all; }
button { font: inherit; }
</style>
</head>
<body>
<h1>Approve access to atc</h1>
<p><strong>${toHTMLText(view.clientName)}</strong> wants access to your atc sessions.</p>
<p>After approval it returns to <code>${toHTMLText(view.redirectURI)}</code>.</p>
<p>Type the approval code that <code>atc mcp --http</code> printed in its terminal.</p>
${error}
<form method="post" action="/login">
<input type="hidden" name="oauth_query" value="${toHTMLText(view.oauthQuery)}">
<label>Approval code <input name="code" autocomplete="off" autofocus required></label>
<button type="submit">Continue</button>
</form>
</body>
</html>
`;
}
