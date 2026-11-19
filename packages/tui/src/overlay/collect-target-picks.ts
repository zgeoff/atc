import { isRecord } from '@atc/core';

export interface TargetPick {
  readonly id: string;
  readonly provider: string;
  readonly available: boolean;
  readonly isDefault: boolean;

  readonly takesWorkspace: boolean;

  readonly inPlace: boolean;

  readonly brokerAuth: boolean;
}

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
        brokerAuth: entry['brokerAuth'] === true,
      },
    ];
  });
}
