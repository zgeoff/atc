import type { GrantScope } from '../shared/grant-scope';
import { toHTMLText } from './to-html-text';

interface ApprovalPageView {
  readonly pendingID: string;
  readonly clientName: string;
  readonly redirectHost: string;
  readonly scopes: readonly GrantScope[];
  readonly error: string | null;
}

const SCOPE_LABELS: Readonly<Record<GrantScope, string>> = {
  read: 'Read sessions, transcripts, and events',
  message: 'Message sessions, rename, pin, and acknowledge them',
  spawn: 'Spawn sessions and type into them',
  kill: 'Kill sessions',
};

// Reading and messaging start granted; spawning and killing start withheld.
const GRANTED_BY_DEFAULT: ReadonlySet<GrantScope> = new Set<GrantScope>(['read', 'message']);

/**
 * The page where the operator approves a client: the client's name and
 * redirect host, a field for the approval code atc printed in its terminal,
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
.error { color: #b00020; }
button { font: inherit; margin-right: 0.5rem; }
</style>
</head>
<body>
<h1>Approve access to atc</h1>
<p><strong>${toHTMLText(view.clientName)}</strong> wants access to your atc sessions. It returns to <strong>${toHTMLText(view.redirectHost)}</strong>.</p>
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
