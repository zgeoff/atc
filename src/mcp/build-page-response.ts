import { toHTMLText } from './to-html-text';

/**
 * An HTML response from the authorization server, sent with headers that
 * keep it out of frames and caches and confine where its form may post.
 * `body` is either a full page or a plain message, which is escaped and
 * wrapped in a minimal page.
 */
export function buildPageResponse(
  status: number,
  body: { readonly page: string } | { readonly message: string },
  formTargets: readonly string[] = [],
): Response {
  const html =
    'page' in body
      ? body.page
      : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>atc</title></head><body><p>${toHTMLText(body.message)}</p></body></html>`;

  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formTargets.map((target) => ` ${target}`).join('')}; frame-ancestors 'none'; base-uri 'none'`,
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}
