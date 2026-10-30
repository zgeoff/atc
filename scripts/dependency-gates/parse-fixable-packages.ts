import { isRecord } from './is-record.ts';

export function parseFixablePackages(output: string): string[] {
  const plan: unknown = JSON.parse(output);

  if (!isRecord(plan)) {
    throw new TypeError('bun audit fix --json printed no object');
  }

  const stuck = new Set([...collectNames(plan, 'blocked'), ...collectNames(plan, 'unfixable')]);

  return [...new Set(collectNames(plan, 'fixes'))].filter((name) => !stuck.has(name));
}

function collectNames(plan: Record<string, unknown>, key: string): string[] {
  const list = plan[key];

  if (!Array.isArray(list)) {
    throw new TypeError(`bun audit fix --json has no ${key} list`);
  }

  return list.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry['name'] !== 'string') {
      throw new TypeError(`bun audit fix --json has an entry with no name in its ${key} list`);
    }

    return entry['name'];
  });
}
