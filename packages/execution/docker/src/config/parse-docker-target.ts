export interface DockerTarget {
  readonly image: string;
  readonly socket: string;
  readonly namePrefix: string;
  readonly signInVolume: string;
  readonly guestDir: string;
}

export type DockerTargetParse =
  | { readonly kind: 'parsed'; readonly target: DockerTarget }
  | { readonly kind: 'refused'; readonly problem: string };

const DEFAULT_SOCKET = '/var/run/docker.sock';
const DEFAULT_NAME_PREFIX = 'atc-';
const DEFAULT_GUEST_DIR = '/atc';

// Docker's rule for a container or volume name
const NAME_START = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;

// The target's options with each default laid in, or the first problem with them. A problem
// names a key, never a value.
export function parseDockerTarget(
  id: string,
  options: Readonly<Record<string, unknown>>,
): DockerTargetParse {
  const target = JSON.stringify(id);
  const image = options['image'];

  if (typeof image !== 'string' || image === '') {
    return refuse(`target ${target} must give image as the name of the image every container runs`);
  }

  const socket = options['socket'] ?? DEFAULT_SOCKET;

  if (typeof socket !== 'string' || !socket.startsWith('/')) {
    return refuse(`target ${target} must give socket as an absolute path`);
  }

  const namePrefix = options['namePrefix'] ?? DEFAULT_NAME_PREFIX;

  if (typeof namePrefix !== 'string' || !NAME_START.test(namePrefix)) {
    return refuse(
      `target ${target} must give namePrefix as letters, digits, underscores, dots or hyphens, starting with a letter or digit`,
    );
  }

  const signInVolume = options['signInVolume'] ?? `${namePrefix}sign-in`;

  if (typeof signInVolume !== 'string' || !NAME_START.test(signInVolume)) {
    return refuse(`target ${target} must give signInVolume as a Docker volume name`);
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

  return { kind: 'parsed', target: { image, socket, namePrefix, signInVolume, guestDir } };
}

function refuse(problem: string): DockerTargetParse {
  return { kind: 'refused', problem };
}
