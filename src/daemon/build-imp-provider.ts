import { ImpClientPort } from './imp-client-port';
import { ImpProvider } from './imp-provider';

/**
 * The provider of an `imp` target, or the problem that keeps it from one.
 * A problem never includes the token or any other environment value.
 */
export interface ImpProviderBuild {
  readonly provider: ImpProvider | null;
  readonly problem: string | null;
}

/**
 * The provider of target `id` from its `imp` options: `url` is where impd
 * listens, and `tokenEnv` holds the name of the daemon's environment
 * variable that carries the token, so no credential sits in the config.
 * `image`, `memoryMib`, `guestDir`, and `guestATC` pass through. No
 * provider when `url` is missing, so the target lists and refuses every
 * spawn. A `tokenEnv` that is not a non-empty string, or whose variable is
 * unset or empty in `env`, is a problem and leaves no provider; a target
 * without `tokenEnv` calls impd with no token.
 */
export function buildImpProvider(
  id: string,
  options: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ImpProviderBuild {
  const url = options['url'];
  const tokenEnv = options['tokenEnv'];

  if (typeof url !== 'string' || url === '') {
    return { provider: null, problem: null };
  }

  if (tokenEnv !== undefined && (typeof tokenEnv !== 'string' || tokenEnv === '')) {
    return {
      provider: null,
      problem: `target ${JSON.stringify(id)} must give tokenEnv as a non-empty string`,
    };
  }

  const token = tokenEnv === undefined ? null : env[tokenEnv];

  if (token === undefined || token === '') {
    return {
      provider: null,
      problem: `target ${JSON.stringify(id)} reads its impd token from ${String(tokenEnv)}, which is unset or empty in the daemon's environment`,
    };
  }

  const provider = new ImpProvider(new ImpClientPort({ url, token }), {
    ...pickString(options, 'image'),
    ...pickString(options, 'guestDir'),
    ...pickString(options, 'guestATC'),
    ...(typeof options['memoryMib'] === 'number' ? { memoryMib: options['memoryMib'] } : {}),
  });

  return { provider, problem: null };
}

function pickString(
  options: Readonly<Record<string, unknown>>,
  key: 'image' | 'guestDir' | 'guestATC',
): Partial<Record<typeof key, string>> {
  const value = options[key];

  return typeof value === 'string' && value !== '' ? { [key]: value } : {};
}
