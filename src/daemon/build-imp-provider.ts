import { ImpClientPort } from './imp-client-port';
import { ImpProvider } from './imp-provider';
import { readImpToken } from './read-imp-token';

/**
 * The provider of an `imp` target, or the problem that keeps it from one.
 * A problem never includes a token or any other environment value.
 */
export interface ImpProviderBuild {
  readonly provider: ImpProvider | null;
  readonly problem: string | null;
}

/**
 * The provider of target `id` from its `imp` options: `url` is where impd
 * listens, and at most one of `tokenEnv` and `tokenFile` gives the token,
 * so no credential sits in the config. `tokenEnv` holds the name of the
 * daemon's environment variable that carries the token, read once here.
 * `tokenFile` holds the path of a file that carries it, read here and again
 * before each impd call and connection. `image`, `memoryMib`, `guestDir`,
 * and `guestATC` pass through. No provider when `url` is missing, so the
 * target lists and refuses every spawn. Both token options, either one not
 * a non-empty string, an unset or empty variable, or an empty or unreadable
 * file is a problem and leaves no provider; a target without either calls
 * impd with no token.
 */
export function buildImpProvider(
  id: string,
  options: Readonly<Record<string, unknown>>,
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

  const provider = new ImpProvider(new ImpClientPort({ url, readToken: source.readToken }), {
    ...pickString(options, 'image'),
    ...pickString(options, 'guestDir'),
    ...pickString(options, 'guestATC'),
    ...(typeof options['memoryMib'] === 'number' ? { memoryMib: options['memoryMib'] } : {}),
  });

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

function pickString(
  options: Readonly<Record<string, unknown>>,
  key: 'image' | 'guestDir' | 'guestATC',
): Partial<Record<typeof key, string>> {
  const value = options[key];

  return typeof value === 'string' && value !== '' ? { [key]: value } : {};
}
