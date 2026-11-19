import { DEFAULT_SPRITE_PREFIX } from '@atc/config';

export type SpritesTokenSource =
  | { readonly kind: 'env'; readonly name: string }
  | { readonly kind: 'file'; readonly path: string };

export interface SpritesTarget {
  readonly token: SpritesTokenSource;
  readonly spritePrefix: string;
  readonly apiURL: string;
  readonly guestDir: string;
}

export type SpritesTargetParse =
  | { readonly kind: 'parsed'; readonly target: SpritesTarget }
  | { readonly kind: 'refused'; readonly problem: string };

const DEFAULT_API_URL = 'https://api.sprites.dev';
const DEFAULT_GUEST_DIR = '/home/sprite/.atc';

// a sprite name is lowercase letters, digits and hyphens, and a prefix leaves room for a host key
const PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/u;

// The target's options with each default laid in, or the first problem with them. A problem
// names a key, never a value.
export function parseSpritesTarget(
  id: string,
  options: Readonly<Record<string, unknown>>,
): SpritesTargetParse {
  const target = JSON.stringify(id);
  const tokenEnv = options['tokenEnv'];
  const tokenFile = options['tokenFile'];

  if ((tokenEnv === undefined) === (tokenFile === undefined)) {
    return refuse(`target ${target} must give exactly one of tokenEnv and tokenFile`);
  }

  let token: SpritesTokenSource;

  if (tokenEnv === undefined) {
    if (typeof tokenFile !== 'string' || !tokenFile.startsWith('/')) {
      return refuse(`target ${target} must give tokenFile as an absolute path`);
    }

    token = { kind: 'file', path: tokenFile };
  } else {
    if (typeof tokenEnv !== 'string' || tokenEnv === '') {
      return refuse(`target ${target} must give tokenEnv as a non-empty string`);
    }

    token = { kind: 'env', name: tokenEnv };
  }

  const spritePrefix = options['spritePrefix'] ?? DEFAULT_SPRITE_PREFIX;

  if (typeof spritePrefix !== 'string' || !PREFIX_PATTERN.test(spritePrefix)) {
    return refuse(
      `target ${target} must give spritePrefix as lowercase letters, digits and hyphens, starting with a letter or digit`,
    );
  }

  const apiURL = options['apiURL'] ?? DEFAULT_API_URL;

  if (typeof apiURL !== 'string' || !/^https?:\/\/[^/\s]+$/u.test(apiURL)) {
    return refuse(`target ${target} must give apiURL as an http or https origin with no path`);
  }

  const guestDir = options['guestDir'] ?? DEFAULT_GUEST_DIR;

  if (
    typeof guestDir !== 'string' ||
    !/^\/[^\s]+$/u.test(guestDir) ||
    guestDir.endsWith('/') ||
    guestDir.includes('//')
  ) {
    return refuse(`target ${target} must give guestDir as an absolute path with no trailing slash`);
  }

  return { kind: 'parsed', target: { token, spritePrefix, apiURL, guestDir } };
}

function refuse(problem: string): SpritesTargetParse {
  return { kind: 'refused', problem };
}
