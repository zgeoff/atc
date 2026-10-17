import { normalizeGitURL } from './normalize-git-url';

export function collectCredentialConfigKeys(listing: string): string[] {
  const keys = new Set<string>();

  for (const entry of listing.split('\0')) {
    const newline = entry.indexOf('\n');
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const value = newline === -1 ? '' : entry.slice(newline + 1);

    if (isCredentialEntry(key.toLowerCase(), key, value)) {
      keys.add(key);
    }
  }

  return [...keys];
}

const URL_WITH_USERINFO = /^[a-z][a-z\d+.-]*:\/\/[^/]*@/iu;

function isCredentialEntry(lowered: string, key: string, value: string): boolean {
  if (lowered.startsWith('credential.')) {
    return true;
  }

  // an Authorization header rides in an http extra header
  if (lowered.startsWith('http.') && lowered.endsWith('.extraheader')) {
    return true;
  }

  if (lowered.startsWith('remote.') && /\.(?:url|pushurl)$/u.test(lowered)) {
    const normalized = normalizeGitURL(value);

    return !normalized.ok || normalized.url !== value;
  }

  const rewrite = /^url\.(?<base>.+)\.(?:insteadof|pushinsteadof)$/iu.exec(key);

  if (rewrite !== null) {
    return URL_WITH_USERINFO.test(rewrite.groups?.['base'] ?? '') || URL_WITH_USERINFO.test(value);
  }

  return false;
}
