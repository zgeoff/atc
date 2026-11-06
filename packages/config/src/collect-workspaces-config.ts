import { isRecord } from '@atc/core';
import { DEFAULT_GIT_TRANSPORTS } from './default-git-transports';

export interface InvalidGitTransports {
  readonly invalid: string;
}

// unpushed removes a workspace only once its work is pushed; none removes it whatever it holds
export type WorkspaceCleanupCheck = 'unpushed' | 'none';

export interface WorkspaceCleanupConfig {
  readonly enabled: boolean;
  readonly check: WorkspaceCleanupCheck;
}

// a root is kept as written; whether it fits its target, such as `~` on a
// remote target, is checked where the target is known.
export interface WorkspacesConfig {
  readonly gitTransports: readonly string[] | InvalidGitTransports;
  readonly root: string | null;
  readonly targetRoots: ReadonlyMap<string, string>;
  readonly cleanup: WorkspaceCleanupConfig;
}

interface CollectedWorkspacesConfig {
  readonly workspaces: WorkspacesConfig;

  // The config problems the section holds, one line each.
  readonly errors: readonly string[];
}

export function collectWorkspacesConfig(raw: unknown): CollectedWorkspacesConfig {
  const section = isRecord(raw) ? raw : {};
  const root = section['root'];
  const targets = isRecord(section['targets']) ? section['targets'] : {};
  const transports = collectGitTransports(section['gitTransports']);
  const cleanup = collectCleanup(section['cleanup']);

  return {
    workspaces: {
      gitTransports: transports.transports,
      root: typeof root === 'string' && root !== '' ? root : null,
      targetRoots: new Map(
        Object.entries(targets).flatMap(([id, directory]) =>
          typeof directory === 'string' && directory !== '' ? [[id, directory] as const] : [],
        ),
      ),
      cleanup: cleanup.cleanup,
    },
    errors: [...transports.errors, ...cleanup.errors],
  };
}

// The git transports a config may allow: the defaults, and the two
// opt-ins.
const KNOWN_TRANSPORTS: ReadonlySet<string> = new Set(['https', 'ssh', 'http', 'file']);

// Transports that run a command or read a descriptor on the daemon's host.
const REFUSED_TRANSPORTS: ReadonlySet<string> = new Set(['ext', 'fd']);

function collectGitTransports(raw: unknown): {
  readonly transports: readonly string[] | InvalidGitTransports;
  readonly errors: readonly string[];
} {
  if (raw === undefined) {
    return { transports: DEFAULT_GIT_TRANSPORTS, errors: [] };
  }

  const fallback = 'the daemon runs no git until it is fixed';

  if (!Array.isArray(raw)) {
    const error = `workspaces.gitTransports is not a list of git transports; ${fallback}`;

    return { transports: { invalid: error }, errors: [error] };
  }

  const errors = raw.flatMap((name: unknown) => {
    if (typeof name === 'string' && REFUSED_TRANSPORTS.has(name)) {
      return [
        `workspaces.gitTransports holds '${name}', which atc never allows because it runs a command or reads a descriptor on the daemon host; ${fallback}`,
      ];
    }

    if (typeof name !== 'string' || !KNOWN_TRANSPORTS.has(name)) {
      return [
        `workspaces.gitTransports holds ${JSON.stringify(name)}, which is not a git transport atc allows; ${fallback}`,
      ];
    }

    return [];
  });

  return errors.length === 0
    ? { transports: raw.filter((name): name is string => typeof name === 'string'), errors }
    : { transports: { invalid: errors.join('; ') }, errors };
}

function collectCleanup(raw: unknown): {
  readonly cleanup: WorkspaceCleanupConfig;
  readonly errors: readonly string[];
} {
  if (raw === undefined) {
    return { cleanup: { enabled: true, check: 'unpushed' }, errors: [] };
  }

  const fallback = 'a forget removes no workspace and no state folder until it is fixed';

  if (!isRecord(raw)) {
    return {
      cleanup: { enabled: false, check: 'unpushed' },
      errors: [`workspaces.cleanup is not an object; ${fallback}`],
    };
  }

  const enabled = raw['enabled'];
  const check = raw['check'];

  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return {
      cleanup: { enabled: false, check: 'unpushed' },
      errors: [`workspaces.cleanup.enabled is not true or false; ${fallback}`],
    };
  }

  if (check !== undefined && check !== 'unpushed' && check !== 'none') {
    return {
      cleanup: { enabled: enabled ?? true, check: 'unpushed' },
      errors: [
        `workspaces.cleanup.check holds ${JSON.stringify(check)}, which is neither "unpushed" nor "none"; a forget removes only a workspace whose work is pushed until it is fixed`,
      ],
    };
  }

  return { cleanup: { enabled: enabled ?? true, check: check ?? 'unpushed' }, errors: [] };
}
