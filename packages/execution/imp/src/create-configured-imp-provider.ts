import { createImpClientPort } from './create-imp-client-port';
import { createImpProvider } from './create-imp-provider';
import type { ImpProvider } from './create-imp-provider';
import { readImpToken } from './read-imp-token';

interface ImpProviderBuild {
  readonly provider: ImpProvider | null;
  readonly problem: string | null;
}

export function createConfiguredImpProvider(
  id: string,
  options: Readonly<Record<string, unknown>>,
  version: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ImpProviderBuild {
  const url = options['url'];

  if (typeof url !== 'string' || url === '') {
    return { provider: null, problem: null };
  }

  const source = loadTokenSource(id, options, env);

  if (typeof source === 'string') {
    return { provider: null, problem: source };
  }

  const impPrefix = options['impPrefix'];

  // At most 11 characters keep a name built with a host key's 20 within
  // impd's 31.
  if (impPrefix !== undefined && !isImpPrefix(impPrefix)) {
    return {
      provider: null,
      problem: `target ${JSON.stringify(id)} must give impPrefix as a lowercase letter followed by up to 10 lowercase letters, digits or hyphens, so every imp name it builds is one impd accepts`,
    };
  }

  const rebindChangedAuth = options['rebindChangedAuth'];

  if (rebindChangedAuth !== undefined && typeof rebindChangedAuth !== 'boolean') {
    return {
      provider: null,
      problem: `target ${JSON.stringify(id)} must give rebindChangedAuth as true or false`,
    };
  }

  const dropSysAdmin = options['dropSysAdmin'];

  if (dropSysAdmin !== undefined && typeof dropSysAdmin !== 'boolean') {
    return {
      provider: null,
      problem: `target ${JSON.stringify(id)} must give dropSysAdmin as true or false`,
    };
  }

  const provider = createImpProvider(
    createImpClientPort({ url, readToken: source.readToken }),
    {
      ...(impPrefix === undefined ? {} : { impPrefix }),
      ...(rebindChangedAuth === undefined ? {} : { rebindChangedAuth }),
      ...(dropSysAdmin === undefined ? {} : { dropSysAdmin }),
      ...pickString(options, 'image'),
      ...pickString(options, 'guestDir'),
      ...pickString(options, 'guestATC'),
      ...(typeof options['memoryMib'] === 'number' ? { memoryMib: options['memoryMib'] } : {}),
    },
    { version },
  );

  return { provider, problem: null };
}

// How the port reads the token: a function, so a file token rereads.
interface TokenSource {
  readonly readToken: () => string | null;
}

// The token source the options give, or the problem that keeps the target
// from one. A problem holds a variable's name or a file's path, never a
// token.
function loadTokenSource(
  id: string,
  options: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
): TokenSource | string {
  const tokenEnv = options['tokenEnv'];
  const tokenFile = options['tokenFile'];
  const target = JSON.stringify(id);

  if (tokenEnv !== undefined && tokenFile !== undefined) {
    return `target ${target} must give its impd token through tokenEnv or tokenFile, not both`;
  }

  if (tokenFile !== undefined) {
    if (typeof tokenFile !== 'string' || tokenFile === '') {
      return `target ${target} must give tokenFile as a non-empty string`;
    }

    try {
      readImpToken(tokenFile);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      return `target ${target} reads its impd token from a file it cannot use: ${detail}`;
    }

    return { readToken: () => readImpToken(tokenFile) };
  }

  if (tokenEnv === undefined) {
    return { readToken: () => null };
  }

  if (typeof tokenEnv !== 'string' || tokenEnv === '') {
    return `target ${target} must give tokenEnv as a non-empty string`;
  }

  const token = env[tokenEnv];

  if (token === undefined || token === '') {
    return `target ${target} reads its impd token from ${tokenEnv}, which is unset or empty in the daemon's environment`;
  }

  return { readToken: () => token };
}

// impd's imp name rule, a lowercase letter then up to 30 lowercase letters,
// digits or hyphens, with room left for the 20 characters of a host key.
// It holds no `*`, so the prefix never reads as an imp pattern.
const IMP_PREFIX = /^[a-z][a-z0-9-]{0,10}$/u;

function isImpPrefix(value: unknown): value is string {
  return typeof value === 'string' && IMP_PREFIX.test(value);
}

function pickString(
  options: Readonly<Record<string, unknown>>,
  key: 'image' | 'guestDir' | 'guestATC',
): Partial<Record<typeof key, string>> {
  const value = options[key];

  return typeof value === 'string' && value !== '' ? { [key]: value } : {};
}
