import { isRecord } from './is-record.ts';
import type { AuditAdvisory } from './types.ts';

export function parseAuditAdvisories(output: string): AuditAdvisory[] {
  const report: unknown = JSON.parse(output);

  if (!isRecord(report)) {
    throw new TypeError('bun audit --json printed no object');
  }

  return Object.entries(report).flatMap(([packageName, advisories]) => {
    if (!Array.isArray(advisories)) {
      throw new TypeError(`bun audit --json lists no advisories for ${packageName}`);
    }

    return advisories.map((advisory: unknown) => {
      if (
        !isRecord(advisory) ||
        typeof advisory['id'] !== 'number' ||
        typeof advisory['url'] !== 'string'
      ) {
        throw new TypeError(
          `bun audit --json has an advisory with no id or url for ${packageName}`,
        );
      }

      return {
        advisoryIDs: [String(advisory['id']), ...advisory['url'].split('/').slice(-1)],
        packageName,
      };
    });
  });
}
