import type { GrantScope } from '../shared/grant-scope';
import { toHTMLText } from './to-html-text';
import type { OAuthClientView } from './types';

interface ApprovalPageView {
  readonly pendingID: string;
  readonly client: OAuthClientView;
  readonly redirectURI: string;
  readonly scopes: readonly GrantScope[];
  readonly error: string | null;
}

const SCOPE_LABELS: Readonly<Record<GrantScope, string>> = {
  read: 'Read sessions, transcripts, and events',
  message:
    'Send instructions to your agents, which can run commands on this machine; also rename, pin, and acknowledge sessions',
  spawn: 'Spawn sessions and type into them',
  kill: 'Kill sessions',
};

// Only reading starts granted; every scope that lets the client act starts
// withheld.
const GRANTED_BY_DEFAULT: ReadonlySet<GrantScope> = new Set<GrantScope>(['read']);

/**
 * The page where the operator approves a client: the client's name, whether
 * its identity is verified (and by which host) or self-registered, the full
 * redirect URI, a field for the approval code atc printed in its terminal,
 * and one checkbox per requested scope. Every dynamic value is escaped.
 */
export function renderApprovalPage(view: ApprovalPageView): string {
  const scopeRows = view.scopes
    .map((scope) => {
      const checked = GRANTED_BY_DEFAULT.has(scope) ? ' checked' : '';

      return `<label><input type="checkbox" name="scope" value="${scope}"${checked}> ${toHTMLText(SCOPE_LABELS[scope])}</label>`;
    })
    .join('\n');

  const error = view.error === null ? '' : `<p class="error">${toHTMLText(view.error)}</p>`;

  const identity = view.client.verified
    ? `verified: its identity is published at <strong>${toHTMLText(new URL(view.client.clientID).host)}</strong>`
    : '<strong class="warning">unverified</strong>: it registered itself, so its name is only what it claims';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve access to atc</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
label { display: block; margin: 0.25rem 0; }
input[name="code"] { font: inherit; font-family: ui-monospace, monospace; letter-spacing: 0.1em; padding: 0.25rem; }
.error, .warning { color: #b00020; }
code { word-break: break-all; }
button { font: inherit; margin-right: 0.5rem; }
</style>
</head>
<body>
<h1>Approve access to atc</h1>
<p><strong>${toHTMLText(view.client.name)}</strong> wants access to your atc sessions.</p>
<p>Client: ${identity}.</p>
<p>After approval it returns to <code>${toHTMLText(view.redirectURI)}</code>.</p>
<p>Type the approval code that <code>atc mcp --http</code> printed in its terminal.</p>
${error}
<form method="post" action="/authorize">
<input type="hidden" name="pending" value="${toHTMLText(view.pendingID)}">
<label>Approval code <input name="code" autocomplete="off" autofocus required></label>
<fieldset>
<legend>Allow it to</legend>
${scopeRows}
</fieldset>
<p><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny" formnovalidate>Deny</button></p>
</form>
</body>
</html>
`;
}
