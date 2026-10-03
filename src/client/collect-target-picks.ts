import { isRecord } from '../shared/report';

export interface TargetPick {
  readonly id: string;
  readonly provider: string;
  readonly available: boolean;
  readonly isDefault: boolean;

  // Whether a workspace can be materialized there: the daemon has the
  // provider, and it can both transfer an archive and run a command.
  readonly takesWorkspace: boolean;

  // Whether a session there runs on the daemon's own machine, where a
  // local directory runs in place.
  readonly inPlace: boolean;
}

/**
 * The execution targets an `agents.list` answer holds, in config order. An
 * answer from a daemon without targets, or a malformed entry, yields none.
 */
export function collectTargetPicks(answer: Readonly<Record<string, unknown>>): TargetPick[] {
  const targets = answer['targets'];

  if (!Array.isArray(targets)) {
    return [];
  }

  return targets.flatMap((entry: unknown): TargetPick[] => {
    if (
      !isRecord(entry) ||
      typeof entry['id'] !== 'string' ||
      typeof entry['provider'] !== 'string'
    ) {
      return [];
    }

    const capabilities = isRecord(entry['capabilities']) ? entry['capabilities'] : {};
    const available = entry['available'] === true;

    return [
      {
        id: entry['id'],
        provider: entry['provider'],
        available,
        isDefault: entry['default'] === true,
        takesWorkspace:
          available && capabilities['transfer'] === true && capabilities['run'] === true,
        inPlace: entry['provider'] === 'local-pty',
      },
    ];
  });
}
