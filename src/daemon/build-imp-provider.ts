import { ImpClientPort } from './imp-client-port';
import { ImpProvider } from './imp-provider';

/**
 * The provider of an `imp` target from its options: `url` is where impd
 * listens, and `tokenEnv` holds the name of the daemon's environment
 * variable that carries the token, so no credential sits in the config.
 * `image`, `memoryMib`, `guestDir`, and `guestATC` pass through. Null when
 * `url` is missing, so the target lists and refuses every spawn.
 */
export function buildImpProvider(options: Readonly<Record<string, unknown>>): ImpProvider | null {
  const url = options['url'];
  const tokenEnv = options['tokenEnv'];

  if (typeof url !== 'string' || url === '') {
    return null;
  }

  const token = typeof tokenEnv === 'string' ? (process.env[tokenEnv] ?? null) : null;

  return new ImpProvider(new ImpClientPort({ url, token }), {
    ...pickString(options, 'image'),
    ...pickString(options, 'guestDir'),
    ...pickString(options, 'guestATC'),
    ...(typeof options['memoryMib'] === 'number' ? { memoryMib: options['memoryMib'] } : {}),
  });
}

function pickString(
  options: Readonly<Record<string, unknown>>,
  key: 'image' | 'guestDir' | 'guestATC',
): Partial<Record<typeof key, string>> {
  const value = options[key];

  return typeof value === 'string' && value !== '' ? { [key]: value } : {};
}
