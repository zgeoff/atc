import { toHTMLText } from '../auth/to-html-text';

export function buildPageResponse(
  status: number,
  body: { readonly page: string } | { readonly message: string },
  formTargets: readonly string[] = [],
  scriptSources: readonly string[] = [],
): Response {
  const html =
    'page' in body
      ? body.page
      : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>atc</title></head><body><p>${toHTMLText(body.message)}</p></body></html>`;

  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline';${scriptSources.length === 0 ? '' : ` script-src ${scriptSources.join(' ')};`} form-action 'self'${formTargets.map((target) => ` ${target}`).join('')}; frame-ancestors 'none'; base-uri 'none'`,
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
      'referrer-policy': 'same-origin',
    },
  });
}
